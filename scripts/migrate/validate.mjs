#!/usr/bin/env node
/**
 * validate.mjs
 *
 * Post-migration validation: verifies expected blobs, scans public JSON for PII,
 * and mirrors the API read path by parsing produced blobs through
 * @bccweb/schemas. The schema gate imports the built package from
 * packages/schemas/dist, so run `make build` before this validator.
 *
 * Usage:
 *   BLOB_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=...;..."  \
 *   node scripts/migrate/validate.mjs
 *
 * Against Azurite:
 *   BLOB_CONNECTION_STRING="UseDevelopmentStorage=true" \
 *   node scripts/migrate/validate.mjs
 *
 * Exit code 0 = all checks passed.
 * Exit code 1 = one or more checks failed (see output for details).
 */

import { pathToFileURL } from "node:url";

import { BlobServiceClient } from "@azure/storage-blob";
import { findPiiInObject, PII_FIELDS } from "../lib/pii.mjs";

const PUBLIC_CONTAINER = process.env.BLOB_CONTAINER_NAME ?? process.env.BLOB_CONTAINER ?? "data";
const PRIVATE_CONTAINER = process.env.BLOB_PRIVATE_CONTAINER_NAME ?? process.env.BLOB_PRIVATE_CONTAINER ?? "data-private";

// Null → "" coercions from healed(z.string(), "") for legacy missing FKs.
export const EXPECTED_HEALS = new Set(["sites:clubId", "rounds:siteId"]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(msg) {
  console.log(`  ✓  ${msg}`);
  passed++;
}

function fail(msg) {
  console.error(`  ✗  ${msg}`);
  failed++;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childPath(parent, child) {
  if (typeof child === "number") {
    return `${parent}[${child}]`;
  }
  return parent ? `${parent}.${child}` : child;
}

function normalizeKeyPath(path) {
  return path.replaceAll(/\[\d+\]\.?/g, "").replaceAll("..", ".").replace(/^\./u, "").replace(/\.$/u, "");
}

function valuesMatch(raw, parsed) {
  return Object.is(raw, parsed);
}

/**
 * Directionally classifies schema read healing by walking RAW → PARSED.
 * - strip: key/index existed in RAW and disappeared from parsed.
 * - change: key/index exists in both, but value changed.
 * - add/default: exists only in parsed and is intentionally ignored.
 *
 * @param {unknown} raw
 * @param {unknown} parsed
 * @param {string} [path]
 * @returns {{ strips: string[], changes: string[] }}
 */
export function classifyRawToParsed(raw, parsed, path = "") {
  const result = { strips: [], changes: [] };

  function walk(rawValue, parsedValue, currentPath) {
    if (valuesMatch(rawValue, parsedValue)) {
      return;
    }

    if (Array.isArray(rawValue)) {
      if (!Array.isArray(parsedValue)) {
        result.changes.push(currentPath);
        return;
      }

      rawValue.forEach((item, index) => {
        const itemPath = childPath(currentPath, index);
        if (index >= parsedValue.length) {
          result.strips.push(itemPath);
          return;
        }
        walk(item, parsedValue[index], itemPath);
      });
      return;
    }

    if (isRecord(rawValue)) {
      if (!isRecord(parsedValue)) {
        result.changes.push(currentPath);
        return;
      }

      Object.keys(rawValue).forEach((key) => {
        const keyPath = childPath(currentPath, key);
        if (!hasOwn(parsedValue, key)) {
          result.strips.push(keyPath);
          return;
        }
        walk(rawValue[key], parsedValue[key], keyPath);
      });
      return;
    }

    result.changes.push(currentPath);
  }

  walk(raw, parsed, path);
  return result;
}

/**
 * Download and JSON-parse a blob. Returns null (and records a failure) if the
 * blob does not exist or cannot be parsed.
 *
 * @param {import("@azure/storage-blob").ContainerClient} client
 * @param {string} path
 * @param {boolean} [required=true] If false, a missing blob is silently skipped.
 * @returns {Promise<unknown|null>}
 */
async function readBlob(client, path, required = true) {
  const blobClient = client.getBlockBlobClient(path);
  try {
    const buf = await blobClient.downloadToBuffer();
    try {
      return JSON.parse(buf.toString("utf-8"));
    } catch {
      fail(`${path} — invalid JSON`);
      return null;
    }
  } catch (err) {
    if (err.statusCode === 404) {
      if (required) fail(`${path} — blob not found (404)`);
      return null;
    }
    fail(`${path} — download error: ${err.message}`);
    return null;
  }
}

async function loadBuiltSchemas() {
  try {
    return await import("@bccweb/schemas");
  } catch (err) {
    console.error("Unable to import @bccweb/schemas from the built package.");
    console.error("Run `make build` from the repository root so packages/schemas/dist exists, then re-run this validator.");
    console.error(`Import error: ${err.message}`);
    process.exit(1);
  }
}

// ─── PII scan ─────────────────────────────────────────────────────────────────

async function scanPublicBlobForPii(client, path) {
  const parsed = await readBlob(client, path);
  if (parsed === null) {
    return;
  }

  const hits = findPiiInObject(parsed, PII_FIELDS);
  if (hits.length === 0) {
    ok(`${path} — no PII fields`);
    return;
  }

  for (const hit of hits) {
    fail(`${path} — PII field ${hit.field} at ${hit.path}`);
  }
}

/**
 * Assert that `value` is an array and optionally that it has at least `min`
 * items.
 *
 * @param {string} path Blob path (for error messages)
 * @param {unknown} value
 * @param {number} [min=1]
 * @returns {boolean}
 */
function assertArray(path, value, min = 1) {
  if (!Array.isArray(value)) {
    fail(`${path} — expected array, got ${typeof value}`);
    return false;
  }
  if (value.length < min) {
    fail(`${path} — array has ${value.length} items (expected ≥ ${min})`);
    return false;
  }
  ok(`${path} — ${value.length} items`);
  return true;
}

/**
 * Assert that `value` is a non-null object that has all `requiredKeys`.
 *
 * @param {string} path
 * @param {unknown} value
 * @param {string[]} requiredKeys
 * @returns {boolean}
 */
function assertObject(path, value, requiredKeys = []) {
  if (!isRecord(value)) {
    fail(`${path} — expected object`);
    return false;
  }
  const missing = requiredKeys.filter((key) => !hasOwn(value, key));
  if (missing.length) {
    fail(`${path} — missing fields: ${missing.join(", ")}`);
    return false;
  }
  ok(`${path} — object OK`);
  return true;
}

// ─── Schema gate ──────────────────────────────────────────────────────────────

function schemaMaps(schemas) {
  return {
    public: [
      { family: "rounds", match: (path) => path === "rounds.json", schema: schemas.RoundSummarySchema.array(), schemaName: "RoundSummarySchema[]" },
      { family: "pilots", match: (path) => path === "pilots.json", schema: schemas.PilotSummarySchema.array(), schemaName: "PilotSummarySchema[]" },
      { family: "sites", match: (path) => path === "sites.json", schema: schemas.SiteSummarySchema.array(), schemaName: "SiteSummarySchema[]" },
      { family: "seasons", match: (path) => path === "seasons.json", schema: schemas.SeasonSummarySchema.array(), schemaName: "SeasonSummarySchema[]" },
      { family: "seasons", match: (path) => /^seasons\/[^/]+\.json$/u.test(path), schema: schemas.SeasonSchema, schemaName: "SeasonSchema" },
      { family: "clubs", match: (path) => path === "clubs.json", schema: schemas.ClubSummarySchema.array(), schemaName: "ClubSummarySchema[]" },
      { family: "club-teams", match: (path) => path === "club-teams.json", schema: schemas.ClubTeamSummarySchema.array(), schemaName: "ClubTeamSummarySchema[]" },
    ],
    private: [
      { family: "rounds", match: (path) => /^rounds\/[^/]+\.json$/u.test(path), schema: schemas.RoundSchema, schemaName: "RoundSchema" },
      { family: "pilots", match: (path) => /^pilots\/[^/]+\.json$/u.test(path), schema: schemas.PilotSchema, schemaName: "PilotSchema" },
      { family: "round-briefs", match: (path) => /^round-briefs\/[^/]+\.json$/u.test(path), schema: schemas.BriefSchema, schemaName: "BriefSchema" },
      { family: "signatures", match: (path) => /^signatures\/.+\.json$/u.test(path), schema: schemas.SignatureLedgerSchema, schemaName: "SignatureLedgerSchema" },
      { family: "clubs", match: (path) => /^clubs\/[^/]+\.json$/u.test(path), schema: schemas.ClubSchema, schemaName: "ClubSchema" },
      { family: "club-teams", match: (path) => /^club-teams\/[^/]+\.json$/u.test(path), schema: schemas.ClubTeamSchema, schemaName: "ClubTeamSchema" },
      { family: "sites", match: (path) => /^sites\/[^/]+\.json$/u.test(path), schema: schemas.SiteSchema, schemaName: "SiteSchema" },
      { family: "season-clubs", match: (path) => /^season-clubs\/[^/]+\/(?!index\.json$)[^/]+\.json$/u.test(path), schema: schemas.SeasonClubSchema, schemaName: "SeasonClubSchema" },
      { family: "config", match: (path) => path === "config.json", schema: schemas.ConfigSchema, schemaName: "ConfigSchema" },
    ],
  };
}

function unvalidatedReason(path) {
  if (/^manufacturers(?:\/|\.json$)/u.test(path)) return "manufacturers has no schema";
  if (/^results\//u.test(path)) return "results have no schema";
  if (/^club-history\//u.test(path) || path === "club-history.json") return "club history has no schema";
  if (/^season-clubs\/index\.json$/u.test(path) || /^season-clubs\/[^/]+\/index\.json$/u.test(path)) return "season-club index has no schema";
  if (path === "user-index.json" || /^users\//u.test(path) || /^auth\//u.test(path)) return "auth/user blobs are outside the migration schema gate";
  return "no schema mapping";
}

function issuePath(issue) {
  if (!issue.path || issue.path.length === 0) {
    return "<root>";
  }
  return issue.path.map((part) => (typeof part === "number" ? `[${part}]` : String(part))).join(".").replaceAll(".[", "[");
}

function healKey(family, keyPath) {
  return `${family}:${normalizeKeyPath(keyPath)}`;
}

export function evaluateSchemaParse({ family, schema, raw, expectedHeals = EXPECTED_HEALS }) {
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    return {
      validated: false,
      rejects: parsed.error.issues.map((issue) => issuePath(issue)),
      strips: [],
      heals: [],
    };
  }

  const diff = classifyRawToParsed(raw, parsed.data);
  return {
    validated: true,
    rejects: [],
    strips: diff.strips.map((keyPath) => normalizeKeyPath(keyPath)),
    heals: diff.changes.map((keyPath) => {
      const normalized = normalizeKeyPath(keyPath);
      return {
        keyPath: normalized,
        allowed: expectedHeals.has(`${family}:${normalized}`),
      };
    }),
  };
}

function newSchemaStats() {
  return {
    validated: 0,
    rejects: [],
    strips: [],
    heals: new Map(),
    unexpectedHeals: [],
    unvalidated: [],
  };
}

function recordHeal(stats, family, keyPath, path) {
  const normalized = normalizeKeyPath(keyPath);
  const key = `${family}.${normalized}`;
  const current = stats.heals.get(key) ?? { count: 0, allowed: EXPECTED_HEALS.has(healKey(family, keyPath)), paths: new Set() };
  current.count++;
  current.paths.add(path);
  stats.heals.set(key, current);
  if (!current.allowed) {
    stats.unexpectedHeals.push({ family, keyPath: normalized, path });
  }
}

async function validateBlobWithSchema(containerName, path, raw, mapping, stats) {
  const result = evaluateSchemaParse({ family: mapping.family, schema: mapping.schema, raw });

  if (!result.validated) {
    result.rejects.forEach((rejectPath) => stats.rejects.push({ containerName, family: mapping.family, path, issuePath: rejectPath }));
    return;
  }

  stats.validated++;
  result.strips.forEach((keyPath) => stats.strips.push({ containerName, family: mapping.family, path, keyPath }));
  result.heals.forEach((heal) => recordHeal(stats, mapping.family, heal.keyPath, path));
}

async function runSchemaGate(containerName, client, mappings, stats) {
  for await (const blob of client.listBlobsFlat()) {
    if (!blob.name.endsWith(".json")) {
      continue;
    }

    const mapping = mappings.find((candidate) => candidate.match(blob.name));
    if (!mapping) {
      stats.unvalidated.push({ containerName, path: blob.name, reason: unvalidatedReason(blob.name) });
      continue;
    }

    const raw = await readBlob(client, blob.name);
    if (raw !== null) {
      await validateBlobWithSchema(containerName, blob.name, raw, mapping, stats);
    }
  }
}

function printSchemaSummary(stats) {
  console.log("");
  console.log("── Schema parse gate summary ──");
  console.log(`  Validated: ${stats.validated}`);
  console.log(`  Rejects: ${stats.rejects.length}`);
  console.log(`  Strips: ${stats.strips.length}`);

  for (const reject of stats.rejects) {
    fail(`REJECT ${reject.containerName}/${reject.path} — ${reject.family} issue at ${reject.issuePath}`);
  }

  for (const strip of stats.strips) {
    fail(`STRIP ${strip.containerName}/${strip.path} — ${strip.family}.${strip.keyPath}`);
  }

  if (stats.heals.size === 0) {
    ok("schema heals — none");
  } else {
    for (const [key, heal] of [...stats.heals.entries()].sort()) {
      const status = heal.allowed ? "allowlisted" : "UNEXPECTED";
      const message = `CHANGE ${key} — ${heal.count} heal(s), ${status}`;
      if (heal.allowed) {
        ok(message);
      } else {
        fail(message);
      }
    }
  }

  for (const note of stats.unvalidated) {
    console.log(`  ⚠  unvalidated ${note.containerName}/${note.path} — ${note.reason}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const blobConnectionString = process.env.BLOB_CONNECTION_STRING;
  if (!blobConnectionString) {
    console.error("Missing BLOB_CONNECTION_STRING env var");
    process.exit(1);
  }

  const schemas = await loadBuiltSchemas();
  const maps = schemaMaps(schemas);
  const blobService = BlobServiceClient.fromConnectionString(blobConnectionString);
  const publicClient = blobService.getContainerClient(PUBLIC_CONTAINER);
  const privateClient = blobService.getContainerClient(PRIVATE_CONTAINER);

  console.log("BCCWeb Migration Validator");
  console.log(`  Public container: ${PUBLIC_CONTAINER}`);
  console.log(`  Private container: ${PRIVATE_CONTAINER}`);
  console.log("  Schema package: @bccweb/schemas (built dist; run `make build` if import fails)");
  console.log("");

  // ── Top-level index blobs ───────────────────────────────────────────────────
  console.log("── Top-level blobs ──");

  const config = await readBlob(privateClient, "config.json");
  assertObject("data-private/config.json", config, ["wingFactors", "maxScoringPilotsInTeam"]);

  const userIndex = await readBlob(privateClient, "user-index.json", /* required= */ false);
  if (userIndex !== null) {
    assertObject("data-private/user-index.json", userIndex);
  } else {
    ok("data-private/user-index.json — not yet created (expected before first login)");
  }

  const pilots = await readBlob(publicClient, "pilots.json");
  const pilotsOk = assertArray("pilots.json", pilots);

  const clubs = await readBlob(publicClient, "clubs.json");
  const clubsOk = assertArray("clubs.json", clubs);

  const sites = await readBlob(publicClient, "sites.json");
  assertArray("sites.json", sites);

  const rounds = await readBlob(publicClient, "rounds.json");
  const roundsOk = assertArray("rounds.json", rounds);

  const seasons = await readBlob(publicClient, "seasons.json");
  const seasonsOk = assertArray("seasons.json", seasons);

  await readBlob(privateClient, "manufacturers.json");

  console.log("");

  console.log("── Public blob PII scan ──");
  for await (const blob of publicClient.listBlobsFlat()) {
    if (blob.name.endsWith(".json")) {
      await scanPublicBlobForPii(publicClient, blob.name);
    }
  }

  console.log("");

  // ── Per-entity spot-checks ──────────────────────────────────────────────────
  console.log("── Pilot spot-check (first 3) ──");
  if (pilotsOk && pilots.length > 0) {
    const sample = pilots.slice(0, 3);
    for (const pilot of sample) {
      const doc = await readBlob(privateClient, `pilots/${pilot.id}.json`);
      assertObject(`data-private/pilots/${pilot.id}.json`, doc, ["id", "person", "pilotRating"]);
    }
  }

  console.log("");
  console.log("── Club spot-check (first 3) ──");
  if (clubsOk && clubs.length > 0) {
    const sample = clubs.slice(0, 3);
    for (const club of sample) {
      const doc = await readBlob(privateClient, `clubs/${club.id}.json`);
      assertObject(`data-private/clubs/${club.id}.json`, doc, ["id", "name"]);
    }
  }

  console.log("");
  console.log("── Round spot-check (last 3 by date) ──");
  if (roundsOk && rounds.length > 0) {
    const sorted = [...rounds].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    const sample = sorted.slice(0, 3);
    for (const round of sample) {
      const doc = await readBlob(privateClient, `rounds/${round.id}.json`);
      if (assertObject(`data-private/rounds/${round.id}.json`, doc, ["id", "date", "status", "teams"])) {
        if (!Array.isArray(doc.teams)) {
          fail(`data-private/rounds/${round.id}.json — teams is not an array`);
        } else {
          ok(`data-private/rounds/${round.id}.json — ${doc.teams.length} teams`);
          passed++; // extra check preserved from the legacy validator.
        }
      }
    }
  }

  console.log("");
  console.log("── Season spot-check ──");
  if (seasonsOk && seasons.length > 0) {
    for (const season of seasons) {
      const doc = await readBlob(publicClient, `seasons/${season.year}.json`);
      if (assertObject(`seasons/${season.year}.json`, doc, ["year", "leagueTable", "rounds"])) {
        if (!Array.isArray(doc.leagueTable)) {
          fail(`seasons/${season.year}.json — leagueTable is not an array`);
        } else if (doc.leagueTable.length === 0 && doc.rounds.length > 0) {
          fail(`seasons/${season.year}.json — leagueTable is empty but ${doc.rounds.length} rounds exist`);
        } else {
          ok(`seasons/${season.year}.json — leagueTable: ${doc.leagueTable.length} entries`);
          passed++;
        }

        const results = await readBlob(publicClient, `results/${season.year}.json`, /* required= */ false);
        if (results !== null) {
          if (Array.isArray(results)) {
            ok(`results/${season.year}.json — ${results.length} round results`);
            passed++;
          } else {
            fail(`results/${season.year}.json — expected array`);
          }
        } else {
          ok(`results/${season.year}.json — not yet created`);
        }
      }
    }
  }

  console.log("");
  console.log("── Schema parse gate ──");
  const schemaStats = newSchemaStats();
  await runSchemaGate(PUBLIC_CONTAINER, publicClient, maps.public, schemaStats);
  await runSchemaGate(PRIVATE_CONTAINER, privateClient, maps.private, schemaStats);
  printSchemaSummary(schemaStats);

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("");
  console.log("─────────────────────────────────────────");
  console.log(`  Passed: ${passed}`);
  if (failed > 0) {
    console.error(`  Failed: ${failed}`);
    console.error("  Migration validation FAILED — fix issues above before cutover.");
    process.exit(1);
  } else {
    console.log("  Migration validation PASSED — data looks correct.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Validator crashed:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
