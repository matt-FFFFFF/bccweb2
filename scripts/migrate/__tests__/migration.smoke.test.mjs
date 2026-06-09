/**
 * migration.smoke.test.mjs — End-to-end smoke test for scripts/migrate/migrate.mjs.
 *
 * Pipeline (Task 43):
 *   1. Verify Docker + Azurite are available — skip with a loud message otherwise.
 *   2. Spin up an ephemeral SQL Server (Azure SQL Edge on arm64; full MSSQL on amd64).
 *   3. Seed the canned fixture (scripts/migrate/fixtures/canned/{schema,seed}.sql).
 *   4. Run `migrate.mjs --dry-run` twice; assert byte-identical stdout (T8 idempotency).
 *   5. Run `migrate.mjs` for real; assert per-entity blob counts and spot-check shapes.
 *   6. Run `reconcile.mjs`; assert zero anomalies.
 *   7. Run `privacy-scan.mjs --source <azurite>`; assert exit 0 (no PII in public blobs).
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
const RECONCILE_SCRIPT = join(MIGRATE_DIR, "reconcile.mjs");
const PRIVACY_SCRIPT = join(REPO_ROOT, "scripts", "privacy-scan.mjs");

const AZURITE_CS =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

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

const dockerOk = checkDocker();
const azuriteOk = await checkAzurite();

if (!dockerOk) {
  console.log("[SKIP] migration.smoke: Docker not available; skipping smoke test.");
}
if (!azuriteOk) {
  console.log(
    "[SKIP] migration.smoke: Azurite not reachable at 127.0.0.1:10000; skipping smoke test.",
  );
}

const SKIP = !dockerOk || !azuriteOk;

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

  // Resolve the container IP — published-port mapping is unreliable under
  // Apple's `container` runtime, so we connect via the container network IP.
  const inspect = JSON.parse(
    execSync(`docker inspect ${MSSQL_CONTAINER}`).toString(),
  );
  const networks = inspect[0]?.NetworkSettings?.Networks ?? {};
  const ip = Object.values(networks).find((n) => n?.IPAddress)?.IPAddress;
  if (!ip) {
    throw new Error(
      "Could not determine MSSQL container IP from `docker inspect` output.",
    );
  }
  mssqlHost = ip;

  // Poll until SQL Server accepts connections (Azure SQL Edge cold start
  // typically completes in 30–45s).
  const deadline = Date.now() + 120_000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const pool = await sql.connect({
        server: mssqlHost,
        port: mssqlPort,
        user: "sa",
        password: MSSQL_PASSWORD,
        database: "master",
        options: { encrypt: false, trustServerCertificate: true },
        connectionTimeout: 5_000,
      });
      await pool.request().query("SELECT 1 AS ok");
      await pool.close();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2_000));
    }
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
  assert.equal(roundsIndex.length, 2, "rounds.json length");
  const completeRound = roundsIndex.find((r) => r.status === "Complete");
  assert.ok(completeRound, "exactly one round should have status Complete");
  assert.equal(completeRound.siteName, "Test Site Bravo");

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
  assert.equal(countPrefix("rounds/"), 2, "private rounds/{uuid}.json count");
  assert.equal(countPrefix("manufacturers/"), 3, "manufacturers/{uuid}.json count");
  // season-clubs/{year}/{clubId}.json are private (detail), one per row → 3.
  // The yearly index lives in the PUBLIC container, not here.
  assert.equal(countPrefix("season-clubs/"), 3, "private season-clubs detail count");
  assert.equal(countPrefix("round-briefs/"), 1, "round-briefs count");
  // Three RoundTeamPilots in the Complete round all had SignToFly=true except
  // pilot 203 → expect 2 legacy-migrated signature blobs.
  assert.equal(countPrefix("signatures/"), 2, "legacy-migrated signatures (T18) count");

  // Spot-check: one pilot blob has the expected shape.
  const pilotDoc = await readJsonBlob(PRIVATE_CONTAINER, pilotDocs[0]);
  assert.equal(typeof pilotDoc.id, "string");
  assert.equal(typeof pilotDoc.legacyId, "number");
  assert.ok(pilotDoc.person, "pilot doc carries embedded person");
  assert.equal(typeof pilotDoc.person.firstName, "string");
  assert.equal(typeof pilotDoc.person.lastName, "string");
  assert.equal(typeof pilotDoc.coachType, "string");
  assert.equal(typeof pilotDoc.pilotRating, "string");

  // Spot-check: the Complete round's blob has 3 teams, each with pilots[]
  // and the place-1 pilot carries a non-null pilotId.
  const completeRoundDoc = await readJsonBlob(
    PRIVATE_CONTAINER,
    `rounds/${completeRound.id}.json`,
  );
  assert.equal(completeRoundDoc.teams.length, 3, "complete round has 3 teams");
  for (const team of completeRoundDoc.teams) {
    const place1 = team.pilots.find((p) => p.placeInTeam === 1);
    assert.ok(place1, "every team has a place-1 pilot slot");
    assert.equal(typeof place1.pilotId, "string", "place-1 pilotId is a UUID string");
    assert.ok(place1.flight, "place-1 slot has a flight");
    assert.ok(place1.flight.distance > 0, "flight has non-zero distance");
  }
  // Scoring should have run: at least one team has a positive score.
  assert.ok(
    completeRoundDoc.teams.some((t) => t.score > 0),
    "complete round has at least one team with score > 0 after scoreRound()",
  );

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
