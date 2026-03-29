#!/usr/bin/env node
/**
 * validate.mjs
 *
 * Post-migration validation: verifies that all expected blobs exist in
 * Azure Blob Storage and spot-checks their content for structural correctness.
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

import { BlobServiceClient } from "@azure/storage-blob";

const BLOB_CS = process.env.BLOB_CONNECTION_STRING;
const CONTAINER = process.env.BLOB_CONTAINER ?? "data";

if (!BLOB_CS) {
  console.error("Missing BLOB_CONNECTION_STRING env var");
  process.exit(1);
}

const blobService = BlobServiceClient.fromConnectionString(BLOB_CS);
const containerClient = blobService.getContainerClient(CONTAINER);

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

/**
 * Download and JSON-parse a blob. Returns null (and records a failure) if the
 * blob does not exist or cannot be parsed.
 *
 * @param {string} path
 * @param {boolean} [required=true]  If false, a missing blob is silently skipped.
 * @returns {Promise<unknown|null>}
 */
async function readBlob(path, required = true) {
  const client = containerClient.getBlockBlobClient(path);
  try {
    const buf = await client.downloadToBuffer();
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

/**
 * Assert that `value` is an array and optionally that it has at least `min`
 * items.
 *
 * @param {string} path    Blob path (for error messages)
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} — expected object`);
    return false;
  }
  const missing = requiredKeys.filter((k) => !(k in value));
  if (missing.length) {
    fail(`${path} — missing fields: ${missing.join(", ")}`);
    return false;
  }
  ok(`${path} — object OK`);
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("BCCWeb Migration Validator");
  console.log(`  Container: ${CONTAINER}`);
  console.log("");

  // ── Top-level index blobs ───────────────────────────────────────────────────
  console.log("── Top-level blobs ──");

  const config = await readBlob("config.json");
  assertObject("config.json", config, ["wingFactors", "maxScoringPilotsInTeam"]);

  const userIndex = await readBlob("user-index.json", /* required= */ false);
  if (userIndex !== null) {
    assertObject("user-index.json", userIndex);
  } else {
    ok("user-index.json — not yet created (expected before first login)");
  }

  const pilots = await readBlob("pilots.json");
  const pilotsOk = assertArray("pilots.json", pilots);

  const clubs = await readBlob("clubs.json");
  const clubsOk = assertArray("clubs.json", clubs);

  const sites = await readBlob("sites.json");
  assertArray("sites.json", sites);

  const rounds = await readBlob("rounds.json");
  const roundsOk = assertArray("rounds.json", rounds);

  const seasons = await readBlob("seasons.json");
  const seasonsOk = assertArray("seasons.json", seasons);

  await readBlob("manufacturers.json");
  await readBlob("pilot-ratings.json");

  console.log("");

  // ── Per-entity spot-checks ──────────────────────────────────────────────────
  console.log("── Pilot spot-check (first 3) ──");
  if (pilotsOk && pilots.length > 0) {
    const sample = pilots.slice(0, 3);
    for (const p of sample) {
      const doc = await readBlob(`pilots/${p.id}.json`);
      assertObject(`pilots/${p.id}.json`, doc, ["id", "person", "pilotRating"]);
    }
  }

  console.log("");
  console.log("── Club spot-check (first 3) ──");
  if (clubsOk && clubs.length > 0) {
    const sample = clubs.slice(0, 3);
    for (const c of sample) {
      const doc = await readBlob(`clubs/${c.id}.json`);
      assertObject(`clubs/${c.id}.json`, doc, ["id", "name"]);
    }
  }

  console.log("");
  console.log("── Round spot-check (last 3 by date) ──");
  if (roundsOk && rounds.length > 0) {
    const sorted = [...rounds].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    const sample = sorted.slice(0, 3);
    for (const r of sample) {
      const doc = await readBlob(`rounds/${r.id}.json`);
      if (assertObject(`rounds/${r.id}.json`, doc, ["id", "date", "status", "teams"])) {
        if (!Array.isArray(doc.teams)) {
          fail(`rounds/${r.id}.json — teams is not an array`);
        } else {
          ok(`rounds/${r.id}.json — ${doc.teams.length} teams`);
          passed++; // extra check
        }
      }
    }
  }

  console.log("");
  console.log("── Season spot-check ──");
  if (seasonsOk && seasons.length > 0) {
    for (const s of seasons) {
      const doc = await readBlob(`seasons/${s.year}.json`);
      if (assertObject(`seasons/${s.year}.json`, doc, ["year", "leagueTable", "rounds"])) {
        if (!Array.isArray(doc.leagueTable)) {
          fail(`seasons/${s.year}.json — leagueTable is not an array`);
        } else if (doc.leagueTable.length === 0 && doc.rounds.length > 0) {
          fail(`seasons/${s.year}.json — leagueTable is empty but ${doc.rounds.length} rounds exist`);
        } else {
          ok(`seasons/${s.year}.json — leagueTable: ${doc.leagueTable.length} entries`);
          passed++;
        }

        const results = await readBlob(`results/${s.year}.json`, /* required= */ false);
        if (results !== null) {
          if (Array.isArray(results)) {
            ok(`results/${s.year}.json — ${results.length} round results`);
            passed++;
          } else {
            fail(`results/${s.year}.json — expected array`);
          }
        } else {
          ok(`results/${s.year}.json — not yet created`);
        }
      }
    }
  }

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

main().catch((err) => {
  console.error("Validator crashed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
