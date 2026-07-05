/**
 * migration.smoke.test.mjs — End-to-end smoke test for scripts/migrate/migrate.mjs.
 *
 * Pipeline (Task 43):
 *   1. Verify Docker + Azurite are available — skip with a loud message otherwise.
 *   2. Spin up an ephemeral SQL Server (Azure SQL Edge on arm64; full MSSQL on amd64).
 *   3. Seed the canned fixture (scripts/migrate/fixtures/canned/{schema,seed}.sql).
 *   4. Run `migrate.mjs --dry-run` twice; assert byte-identical stdout (T8 idempotency).
 *   5. Run `migrate.mjs` for real; assert per-entity blob counts, canonical enums,
 *      and drift-healing guard cases.
 *   6. Run `validate.mjs`; assert schema gate exits 0 with zero rejects/strips.
 *   7. Run `reconcile.mjs`; assert zero anomalies.
 *   8. Run `privacy-scan.mjs --source <azurite>`; assert exit 0 (no PII in public blobs).
 *
 * Isolation:
 *   - CWD for migrate/reconcile is a per-test temp dir (so `.migration-state/` is local).
 *   - Azurite containers are per-test (`smoke-<run-id>` / `smoke-priv-<run-id>`); they are
 *     created and deleted by this test — never the dev `data` / `data-private` containers.
 *
 * Invocation:
 *   node --test scripts/migrate/__tests__/migration.smoke.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import sql from "mssql";
import { BlobServiceClient } from "@azure/storage-blob";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATE_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(MIGRATE_DIR, "..", "..");
const FIXTURE_DIR = join(MIGRATE_DIR, "fixtures", "canned");
const MIGRATE_SCRIPT = join(MIGRATE_DIR, "migrate.mjs");
const VALIDATE_SCRIPT = join(MIGRATE_DIR, "validate.mjs");
const RECONCILE_SCRIPT = join(MIGRATE_DIR, "reconcile.mjs");
const PRIVACY_SCRIPT = join(REPO_ROOT, "scripts", "privacy-scan.mjs");
const SCHEMAS_DIST = resolve(REPO_ROOT, "packages", "schemas", "dist", "index.js");

const AZURITE_CS =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

// Hardcoded from packages/types/src/index.ts; do not import the workspace types/schemas packages here.
const COACH_TYPES = ["None", "ClubCoach", "SeniorCoach", "Instructor", "SeniorInstructor"];
const PILOT_RATINGS = ["Club Pilot", "Pilot", "Advanced Pilot"];
const WING_CLASSES = ["EN A", "EN B", "EN C", "EN C 2-liner", "EN D", "EN D 2-liner"];
const ROUND_STATUSES = ["Proposed", "Confirmed", "BriefComplete", "Locked", "Complete", "Cancelled"];
const PILOT_SLOT_STATUSES = ["Empty", "Filled"];
const SCORING_TYPES = ["XC", "Manual"];

// ─── Pre-flight availability checks ──────────────────────────────────────────

function checkDocker() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

async function checkAzurite() {
  try {
    const svc = BlobServiceClient.fromConnectionString(AZURITE_CS);
    // listContainers returns an async iterator; touching .next() forces a TCP roundtrip.
    const it = svc.listContainers();
    await it.next();
    return true;
  } catch {
    return false;
  }
}

function checkSchemasAvailable() {
  return existsSync(SCHEMAS_DIST);
}

const dockerOk = checkDocker();
const azuriteOk = await checkAzurite();
const schemasOk = checkSchemasAvailable();

if (!dockerOk) {
  console.log("[SKIP] migration.smoke: Docker not available; skipping smoke test.");
}
if (!azuriteOk) {
  console.log(
    "[SKIP] migration.smoke: Azurite not reachable at 127.0.0.1:10000; skipping smoke test.",
  );
}
if (!schemasOk) {
  console.log(
    "[SKIP:SCHEMA-GATE:LOUD] migration.smoke: the built schemas package (packages/schemas/dist) is unavailable; run `make build` from the worktree root before validating migrated blobs.",
  );
}

const SKIP = !dockerOk || !azuriteOk;
const SCHEMA_GATE_SKIP = SKIP || !schemasOk;

// ─── Per-run identifiers ─────────────────────────────────────────────────────

const RUN_ID = randomBytes(4).toString("hex");
const MSSQL_CONTAINER = `bcc-smoke-mssql-${RUN_ID}`;
const PUBLIC_CONTAINER = `smoke-public-${RUN_ID}`;
const PRIVATE_CONTAINER = `smoke-private-${RUN_ID}`;
const MSSQL_PASSWORD = "Smoke123!Strong";

let mssqlHost = null;
let mssqlPort = 1433;
let tmpDir = null;

// ─── Lifecycle ───────────────────────────────────────────────────────────────

before(async () => {
  if (SKIP) return;

  tmpDir = mkdtempSync(join(tmpdir(), "bcc-migrate-smoke-"));

  // Start SQL Server container (Azure SQL Edge: arm64 + amd64 compatible).
  execSync(
    [
      "docker run -d --rm",
      `--name ${MSSQL_CONTAINER}`,
      '-e "ACCEPT_EULA=1"',
      `-e "MSSQL_SA_PASSWORD=${MSSQL_PASSWORD}"`,
      "-p 0:1433",
      "mcr.microsoft.com/azure-sql-edge:latest",
    ].join(" "),
    { stdio: "ignore" },
  );

  // Resolve both possible connection routes. Docker Desktop exposes the random
  // published port on localhost; Apple's `container` runtime historically made
  // that unreliable, so keep the container-network IP route as a fallback.
  const inspect = JSON.parse(
    execSync(`docker inspect ${MSSQL_CONTAINER}`).toString(),
  );
  const networks = inspect[0]?.NetworkSettings?.Networks ?? {};
  const ip = Object.values(networks).find((n) => n?.IPAddress)?.IPAddress;
  const portOutput = execSync(`docker port ${MSSQL_CONTAINER} 1433`).toString().trim();
  const publishedPort = Number(portOutput.match(/:(\d+)$/)?.[1]);
  if (!ip) {
    throw new Error(
      "Could not determine MSSQL container IP from `docker inspect` output.",
    );
  }
  const candidates = [
    { host: ip, port: 1433, label: "container IP" },
    ...(Number.isInteger(publishedPort)
      ? [{ host: "127.0.0.1", port: publishedPort, label: "published localhost port" }]
      : []),
  ];

  // Poll until SQL Server accepts connections (Azure SQL Edge cold start
  // typically completes in 30–45s).
  const deadline = Date.now() + 120_000;
  let lastErr = null;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      try {
        const pool = await sql.connect({
          server: candidate.host,
          port: candidate.port,
          user: "sa",
          password: MSSQL_PASSWORD,
          database: "master",
          options: { encrypt: false, trustServerCertificate: true },
          connectionTimeout: 5_000,
        });
        await pool.request().query("SELECT 1 AS ok");
        await pool.close();
        mssqlHost = candidate.host;
        mssqlPort = candidate.port;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = new Error(
          `${candidate.label} ${candidate.host}:${candidate.port} failed: ${err.message ?? err}`,
        );
      }
    }
    if (!lastErr) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (lastErr) {
    throw new Error(
      `MSSQL never became ready within 120s: ${lastErr.message ?? lastErr}`,
    );
  }

  // Create the smoke DB and load schema + seed.
  await execSqlBatch("master", "CREATE DATABASE bccweb_smoke");
  await execSqlFile("bccweb_smoke", join(FIXTURE_DIR, "schema.sql"));
  await execSqlFile("bccweb_smoke", join(FIXTURE_DIR, "seed.sql"));

  // Pre-create the Azurite containers we are going to write to so the
  // migration's first `upload` call doesn't 404. Public container is
  // configured with blob-level public access (matches prod `data`).
  const svc = BlobServiceClient.fromConnectionString(AZURITE_CS);
  await svc
    .getContainerClient(PUBLIC_CONTAINER)
    .createIfNotExists({ access: "blob" });
  await svc.getContainerClient(PRIVATE_CONTAINER).createIfNotExists();
});

after(async () => {
  // Best-effort teardown — always try to stop the container so a failed
  // test never leaves dangling SQL Server processes.
  if (MSSQL_CONTAINER) {
    try {
      execSync(`docker stop ${MSSQL_CONTAINER}`, { stdio: "ignore" });
    } catch {
      /* container already gone — fine */
    }
  }
  // Drop the per-run Azurite containers (best-effort).
  if (azuriteOk) {
    try {
      const svc = BlobServiceClient.fromConnectionString(AZURITE_CS);
      await svc.getContainerClient(PUBLIC_CONTAINER).deleteIfExists();
      await svc.getContainerClient(PRIVATE_CONTAINER).deleteIfExists();
    } catch {
      /* nothing to clean up */
    }
  }
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sqlConnectionString(database) {
  return (
    `Server=${mssqlHost},${mssqlPort};` +
    "User Id=sa;" +
    `Password=${MSSQL_PASSWORD};` +
    `Database=${database};` +
    "Encrypt=false;TrustServerCertificate=true;"
  );
}

async function execSqlBatch(database, batch) {
  const pool = await sql.connect({
    server: mssqlHost,
    port: mssqlPort,
    user: "sa",
    password: MSSQL_PASSWORD,
    database,
    options: { encrypt: false, trustServerCertificate: true },
  });
  try {
    await pool.request().batch(batch);
  } finally {
    await pool.close();
  }
}

async function execSqlFile(database, path) {
  const text = readFileSync(path, "utf8");
  // mssql's .batch() honours GO when splitting; the canned fixtures don't
  // use GO so a single batch call is fine.
  await execSqlBatch(database, text);
}

function runMigration({ dryRun }) {
  const env = {
    ...process.env,
    SQL_CONNECTION_STRING: sqlConnectionString("bccweb_smoke"),
    BLOB_CONNECTION_STRING: AZURITE_CS,
    BLOB_CONTAINER: PUBLIC_CONTAINER,
    BLOB_PRIVATE_CONTAINER: PRIVATE_CONTAINER,
  };
  if (dryRun) env.DRY_RUN = "1";
  const args = dryRun ? [MIGRATE_SCRIPT, "--dry-run"] : [MIGRATE_SCRIPT];
  const r = spawnSync("node", args, {
    cwd: tmpDir,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return r;
}

function runValidate() {
  const r = spawnSync("node", [VALIDATE_SCRIPT], {
    cwd: tmpDir,
    env: {
      ...process.env,
      BLOB_CONNECTION_STRING: AZURITE_CS,
      BLOB_CONTAINER_NAME: PUBLIC_CONTAINER,
      BLOB_PRIVATE_CONTAINER_NAME: PRIVATE_CONTAINER,
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return r;
}

function runReconcile() {
  const r = spawnSync("node", [RECONCILE_SCRIPT], {
    cwd: tmpDir,
    env: process.env,
    encoding: "utf8",
  });
  return r;
}

function runPrivacyScan() {
  const r = spawnSync(
    "node",
    [PRIVACY_SCRIPT, "--source", AZURITE_CS],
    {
      cwd: tmpDir,
      env: { ...process.env, BLOB_CONTAINER_NAME: PUBLIC_CONTAINER },
      encoding: "utf8",
    },
  );
  return r;
}

async function listBlobPaths(containerName) {
  const svc = BlobServiceClient.fromConnectionString(AZURITE_CS);
  const c = svc.getContainerClient(containerName);
  const names = [];
  for await (const item of c.listBlobsFlat()) names.push(item.name);
  names.sort();
  return names;
}

async function readJsonBlob(containerName, path) {
  const svc = BlobServiceClient.fromConnectionString(AZURITE_CS);
  const c = svc.getContainerClient(containerName);
  const buf = await c.getBlobClient(path).downloadToBuffer();
  return JSON.parse(buf.toString("utf8"));
}

function assertCanonical(value, allowed, label) {
  assert.ok(
    allowed.includes(value),
    `${label} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`,
  );
}

function assertNoKeysWithPrefix(value, prefix, label) {
  for (const key of Object.keys(value)) {
    assert.ok(!key.startsWith(prefix), `${label} must not include ${prefix}* key ${key}`);
  }
}

// stdout from migrate includes timestamps in `--dry-run` form only for blob
// byte sizes (deterministic from fixture). Strip generated UUIDs and run-time
// noise that legitimately varies (we keep the byte counts and structure).
function normaliseMigrationStdout(s) {
  return s
    // UUIDs (8-4-4-4-12 hex) — generated UUIDs are stable across runs thanks
    // to T8 (id-map persisted in CWD/.migration-state). Leave them in place
    // for the comparison so a regression that breaks T8 also breaks this test.
    .replace(/\r\n/g, "\n");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("migration smoke: dry-run idempotency (T8 byte-identical)", { skip: SKIP }, async () => {
  const first = runMigration({ dryRun: true });
  assert.equal(first.status, 0, `first dry-run failed:\n${first.stderr}\n${first.stdout}`);

  const second = runMigration({ dryRun: true });
  assert.equal(second.status, 0, `second dry-run failed:\n${second.stderr}\n${second.stdout}`);

  const a = normaliseMigrationStdout(first.stdout);
  const b = normaliseMigrationStdout(second.stdout);
  assert.equal(
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
    0,
    `dry-run stdout differed between runs:\n--- first ---\n${a}\n--- second ---\n${b}`,
  );
  assert.equal(a, b, "dry-run stdout is byte-identical after CRLF normalisation");
});

test("migration smoke: real run writes expected blobs", { skip: SKIP }, async () => {
  const r = runMigration({ dryRun: false });
  assert.equal(
    r.status,
    0,
    `migration exited ${r.status}:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
  );
  assert.match(r.stdout, /Migration complete\./);

  // ── Public blob assertions ────────────────────────────────────────────
  const publicBlobs = await listBlobPaths(PUBLIC_CONTAINER);

  // Fixture has 3 clubs → public clubs.json length === 3.
  const clubsIndex = await readJsonBlob(PUBLIC_CONTAINER, "clubs.json");
  assert.ok(Array.isArray(clubsIndex), "clubs.json should be an array");
  assert.equal(clubsIndex.length, 3, "clubs.json length");
  assert.ok(
    clubsIndex.every((c) => typeof c.id === "string" && typeof c.name === "string"),
    "every clubs.json entry has id + name",
  );
  // PII guard: the public clubs index has no PII-bearing fields.
  for (const c of clubsIndex) {
    assert.equal(c.email, undefined);
    assert.equal(c.phoneNumber, undefined);
  }

  const pilotsIndex = await readJsonBlob(PUBLIC_CONTAINER, "pilots.json");
  assert.equal(pilotsIndex.length, 3, "pilots.json length");
  for (const p of pilotsIndex) {
    assert.equal(p.email, undefined, "public pilots index must not carry email");
    assert.equal(p.phoneNumber, undefined, "public pilots index must not carry phone");
    assert.equal(p.medicalInfo, undefined);
  }

  const sitesIndex = await readJsonBlob(PUBLIC_CONTAINER, "sites.json");
  assert.equal(sitesIndex.length, 3, "sites.json length");

  const seasonsIndex = await readJsonBlob(PUBLIC_CONTAINER, "seasons.json");
  assert.equal(seasonsIndex.length, 2, "seasons.json length");

  const roundsIndex = await readJsonBlob(PUBLIC_CONTAINER, "rounds.json");
  assert.equal(roundsIndex.length, 3, "rounds.json length");
  for (const round of roundsIndex) {
    assertCanonical(round.status, ROUND_STATUSES, `rounds.json legacyId=${round.legacyId} status`);
  }
  const completeRound = roundsIndex.find((r) => r.status === "Complete");
  assert.ok(completeRound, "exactly one round should have status Complete");
  assert.equal(completeRound.siteName, "Test Site Bravo");
  const sitelessRound = roundsIndex.find((round) => round.legacyId === 403);
  assert.ok(sitelessRound, "Deleted/siteless legacy round 403 is retained in rounds.json");
  assert.equal(sitelessRound.siteId, null, "siteless legacy round has null summary siteId");
  assert.equal(sitelessRound.siteName, "", "siteless legacy round keeps empty summary siteName");

  // Public season-clubs index for 2026 should have one entry per club.
  const seasonClubIndex2026 = await readJsonBlob(
    PUBLIC_CONTAINER,
    "season-clubs/2026/index.json",
  );
  assert.equal(seasonClubIndex2026.length, 3, "2026 season-club index length");

  // Public results for 2026 should reflect the single Complete round.
  const results2026 = await readJsonBlob(PUBLIC_CONTAINER, "results/2026.json");
  assert.equal(results2026.length, 1, "one Complete round → one entry in results/2026.json");
  assert.equal(results2026[0].teamResults.length, 3, "three teams in the Complete round");
  const resultPilots = results2026[0].teamResults.flatMap((tr) => tr.pilots);
  assert.ok(resultPilots.length >= 3, "produced results carry a pilot row per team's flighted place-1 pilot");
  for (const p of resultPilots) {
    assert.ok(
      p.pilotId === null || typeof p.pilotId === "string",
      `results pilot row pilotId is string|null, never undefined (got ${JSON.stringify(p.pilotId)})`,
    );
  }
  assert.ok(
    resultPilots.some((p) => typeof p.pilotId === "string"),
    "migrated results carry a UUID string pilotId (ported buildSeasonResults emits pilotId in lockstep with recompute.ts)",
  );

  // ── Private blob assertions ───────────────────────────────────────────
  const privateBlobs = await listBlobPaths(PRIVATE_CONTAINER);

  // Per-entity counts under the private container.
  const countPrefix = (prefix) =>
    privateBlobs.filter((p) => p.startsWith(prefix)).length;

  assert.equal(countPrefix("clubs/"), 3, "private clubs/{uuid}.json count");
  assert.equal(countPrefix("sites/"), 3, "private sites/{uuid}.json count");
  // pilots/ includes pilots/{uuid}.json (3) AND pilots/{uuid}/club-history.json (3).
  const pilotsPrivate = privateBlobs.filter((p) => p.startsWith("pilots/"));
  const pilotDocs = pilotsPrivate.filter((p) => /^pilots\/[^/]+\.json$/.test(p));
  const pilotHistoryDocs = pilotsPrivate.filter((p) =>
    /^pilots\/[^/]+\/club-history\.json$/.test(p),
  );
  assert.equal(pilotDocs.length, 3, "pilots/{uuid}.json count");
  assert.equal(pilotHistoryDocs.length, 3, "pilot club-history blob count");
  assert.equal(countPrefix("rounds/"), 3, "private rounds/{uuid}.json count");
  assert.equal(countPrefix("manufacturers/"), 0, "manufacturers/{uuid}.json blobs are no longer written");
  assert.ok(publicBlobs.includes("manufacturers.json"), "manufacturers.json lookup list is written to the public container");
  assert.ok(!privateBlobs.includes("pilot-ratings.json"), "pilot-ratings.json blob is no longer written");
  assert.ok(!privateBlobs.includes("frequencies.json"), "frequencies.json blob is no longer written");
  // season-clubs/{year}/{clubId}.json are private (detail), one per row → 3.
  // The yearly index lives in the PUBLIC container, not here.
  assert.equal(countPrefix("season-clubs/"), 3, "private season-clubs detail count");
  assert.equal(countPrefix("round-briefs/"), 1, "round-briefs count");
  // Three RoundTeamPilots in the Complete round all had SignToFly=true except
  // pilot 203 → expect 2 legacy-migrated signature blobs.
  assert.equal(countPrefix("signatures/"), 2, "legacy-migrated signatures (T18) count");

  // Pilot blobs: expected shape + canonical enum membership.
  const pilotDocsByLegacyId = new Map();
  for (const path of pilotDocs) {
    const doc = await readJsonBlob(PRIVATE_CONTAINER, path);
    pilotDocsByLegacyId.set(doc.legacyId, doc);
    assert.equal(typeof doc.id, "string");
    assert.equal(typeof doc.legacyId, "number");
    assert.ok(doc.person, "pilot doc carries embedded person");
    assert.equal(typeof doc.person.firstName, "string");
    assert.equal(typeof doc.person.lastName, "string");
    assert.notEqual(doc.person.firstName.trim(), "", `pilot ${doc.legacyId} firstName is readable/non-empty`);
    assert.notEqual(doc.person.lastName.trim(), "", `pilot ${doc.legacyId} lastName is readable/non-empty`);
    assertCanonical(doc.coachType, COACH_TYPES, `pilot ${doc.legacyId} coachType`);
    assertCanonical(doc.pilotRating, PILOT_RATINGS, `pilot ${doc.legacyId} pilotRating`);
    if (doc.wingClass !== undefined) {
      assertCanonical(doc.wingClass, WING_CLASSES, `pilot ${doc.legacyId} wingClass`);
    }
  }
  const blankNamePilot = pilotDocsByLegacyId.get(203);
  assert.ok(blankNamePilot, "blank-name legacy pilot 203 is readable");
  assert.equal(blankNamePilot.person.firstName, "Synthetic Charlie", "blank first name falls back to fullName");
  assert.equal(blankNamePilot.person.lastName, "Charlie", "blank-name pilot keeps last name");

  const sitelessRoundDoc = await readJsonBlob(
    PRIVATE_CONTAINER,
    `rounds/${sitelessRound.id}.json`,
  );
  assert.equal(sitelessRoundDoc.site.id, "legacy-no-site", "siteless private round uses sentinel site id");
  assert.equal(sitelessRoundDoc.site.name, "Unknown site", "siteless private round uses readable sentinel site name");

  // Spot-check: the Complete round's blob has 3 teams, each with pilots[]
  // and the place-1 pilot carries a non-null pilotId.
  const completeRoundDoc = await readJsonBlob(
    PRIVATE_CONTAINER,
    `rounds/${completeRound.id}.json`,
  );
  assert.equal(completeRoundDoc.teams.length, 3, "complete round has 3 teams");
  const clublessTeam = completeRoundDoc.teams.find((team) => team.teamName === "Test Club Charlie A");
  assert.ok(clublessTeam, "clubless/nameless legacy team is retained in Complete round");
  assert.equal(clublessTeam.club.id, "legacy-no-club", "clubless team uses sentinel club id");
  assert.equal(clublessTeam.club.name, "Unknown club", "clubless team uses readable sentinel club name");
  for (const team of completeRoundDoc.teams) {
    const place1 = team.pilots.find((p) => p.placeInTeam === 1);
    assert.ok(place1, "every team has a place-1 pilot slot");
    assert.equal(typeof place1.pilotId, "string", "place-1 pilotId is a UUID string");
    assertCanonical(place1.status, PILOT_SLOT_STATUSES, `team ${team.teamName} place-1 status`);
    assertCanonical(place1.snapshot.wingClass, WING_CLASSES, `team ${team.teamName} place-1 wingClass`);
    assertCanonical(place1.snapshot.pilotRating, PILOT_RATINGS, `team ${team.teamName} place-1 pilotRating`);
    assert.ok(place1.flight, "place-1 slot has a flight");
    assert.ok(place1.flight.distance > 0, "flight has non-zero distance");
    assertCanonical(place1.flight.scoringType, SCORING_TYPES, `team ${team.teamName} place-1 scoringType`);
  }
  // Scoring should have run: at least one team has a positive score.
  assert.ok(
    completeRoundDoc.teams.some((t) => t.score > 0),
    "complete round has at least one team with score > 0 after scoreRound()",
  );

  const briefDoc = await readJsonBlob(PRIVATE_CONTAINER, `round-briefs/${completeRound.id}.json`);
  assert.equal(briefDoc.roundId, completeRound.id, "dateless legacy brief for Complete round is readable");
  assert.equal(briefDoc.legacyId, undefined, "round brief omits unmodelled legacyId so schema gate cannot strip it");
  assert.equal(briefDoc.date, completeRoundDoc.date, "dateless brief falls back to round date");
  assert.equal(briefDoc.frequencyMhz, 145.525, "Complete round brief carries organising-club frequencyMhz");
  assertCanonical(briefDoc.briefer.bhpaCoachLevel, COACH_TYPES, "brief briefer.bhpaCoachLevel");
  for (const team of briefDoc.teams) {
    for (const pilot of team.pilots) {
      assertCanonical(pilot.snapshot.wingClass, WING_CLASSES, `brief ${team.teamName} pilot wingClass`);
      assertCanonical(pilot.snapshot.pilotRating, PILOT_RATINGS, `brief ${team.teamName} pilot pilotRating`);
    }
  }

  for (const signaturePath of privateBlobs.filter((path) => path.startsWith("signatures/"))) {
    const signature = await readJsonBlob(PRIVATE_CONTAINER, signaturePath);
    assert.equal(signature.userId, "legacy-import", `${signaturePath} legacy signature userId`);
    assert.equal(signature.source, "legacy-migrated", `${signaturePath} legacy signature source`);
    assert.equal(typeof signature.pilotId, "string", `${signaturePath} legacy signature pilotId`);
  }

  const seasonClubDetailPaths = privateBlobs.filter((path) => /^season-clubs\/[^/]+\/[^/]+\.json$/.test(path));
  assert.equal(seasonClubDetailPaths.length, 3, "season-club detail blob count");
  const seasonClubDetails = [];
  for (const path of seasonClubDetailPaths) {
    const detail = await readJsonBlob(PRIVATE_CONTAINER, path);
    seasonClubDetails.push(detail);
    assertNoKeysWithPrefix(detail, "frequency", `${path} detail`);
    assert.equal(detail.acceptedTsCsAt, undefined, `${path} has no acceptedTsCsAt`);
    assert.equal(detail.acceptedTsCsBy, undefined, `${path} has no acceptedTsCsBy`);
  }
  const acceptTsCsFalseClub = seasonClubDetails.find((detail) => detail.legacyId === 3);
  assert.ok(acceptTsCsFalseClub, "AcceptTsCs=0 season club detail is readable");
  assert.equal(acceptTsCsFalseClub.acceptedTsCs, false, "AcceptTsCs=0 maps to acceptedTsCs:false");

  // ── Sanity: required public blob names are present ────────────────────
  for (const required of [
    "clubs.json",
    "pilots.json",
    "sites.json",
    "seasons.json",
    "rounds.json",
    "seasons/2026.json",
    "results/2026.json",
  ]) {
    assert.ok(
      publicBlobs.includes(required),
      `expected public blob ${required} (got: ${publicBlobs.slice(0, 12).join(", ")}…)`,
    );
  }
});

test("migration smoke: schema gate validates migrated blobs", { skip: SCHEMA_GATE_SKIP }, async () => {
  const r = runValidate();
  assert.equal(
    r.status,
    0,
    `validate exited ${r.status}:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
  );
  assert.match(r.stdout, /── Schema parse gate summary ──/);
  assert.match(r.stdout, /Rejects: 0/, "schema gate rejects must be zero");
  assert.match(r.stdout, /Strips: 0/, "schema gate strips must be zero");
  assert.doesNotMatch(r.stdout, /UNEXPECTED/, "schema gate must not report unexpected heals");
  const healLines = r.stdout
    .split("\n")
    .filter((line) => line.includes("CHANGE "));
  assert.ok(healLines.length > 0, "schema gate should report the siteless-round allowlisted heal");
  for (const line of healLines) {
    assert.match(
      line,
      /CHANGE (sites\.clubId|rounds\.siteId) — \d+ heal\(s\), allowlisted/,
      `schema gate heal must be allowlisted: ${line}`,
    );
  }
  assert.match(r.stdout, /CHANGE rounds\.siteId — \d+ heal\(s\), allowlisted/);
  assert.match(r.stdout, /Migration validation PASSED — data looks correct\./);
  console.log(`\n[validate.mjs stdout]\n${r.stdout.trim()}\n[/validate.mjs stdout]`);
});

test("migration smoke: reconcile reports zero anomalies", { skip: SKIP }, async () => {
  const r = runReconcile();
  assert.equal(
    r.status,
    0,
    `reconcile exited ${r.status}:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
  );
  assert.match(r.stdout, /No anomalies detected\./);

  // Inspect the persisted report directly.
  const reportPath = join(tmpDir, ".migration-state", "reconciliation-report.json");
  assert.ok(existsSync(reportPath), `report missing at ${reportPath}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.anomalies.length, 0, "no anomalies");
  // T32 audit trail: 2 RoundClubPilots in fixture must surface in discarded.
  assert.equal(report.discarded.roundClubPilot, 2);
});

test("migration smoke: privacy-scan passes on public blobs (T22)", { skip: SKIP }, async () => {
  const r = runPrivacyScan();
  assert.equal(
    r.status,
    0,
    `privacy-scan exited ${r.status} (expected 0):\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
  );
  assert.match(
    r.stdout,
    /\[PASS\] public-blob-scan/,
    "privacy-scan should report PASS on public blobs",
  );
});
