#!/usr/bin/env node
/**
 * reconcile.mjs
 *
 * Reads .migration-state/id-map.json and emits a reconciliation report.
 * Useful for auditing migration completeness and detecting anomalies.
 *
 * Usage:
 *   node scripts/migrate/reconcile.mjs
 *
 * Output: .migration-state/reconciliation-report.json
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = ".migration-state";
const MAP_PATH = join(STATE_DIR, "id-map.json");
const REPORT_PATH = join(STATE_DIR, "reconciliation-report.json");
const REPORT_TMP = `${REPORT_PATH}.tmp`;

if (!existsSync(MAP_PATH)) {
  console.error(`No id-map found at ${MAP_PATH}. Run migrate.mjs first.`);
  process.exit(1);
}

let idMap;
try {
  idMap = JSON.parse(readFileSync(MAP_PATH, "utf8"));
} catch (err) {
  console.error(`Failed to parse ${MAP_PATH}: ${err.message}`);
  process.exit(1);
}

// Group UUIDs by entity type (key format: "${entity}:${sqlId}")
const byEntity = /** @type {Record<string, string[]>} */ ({});
for (const [key, uuid] of Object.entries(idMap)) {
  const colonIdx = key.indexOf(":");
  const entity = colonIdx !== -1 ? key.slice(0, colonIdx) : "unknown";
  if (!byEntity[entity]) byEntity[entity] = [];
  byEntity[entity].push(uuid);
}

/** @type {Record<string, { count: number, sample: string[] }>} */
const perEntity = {};
for (const [entity, uuids] of Object.entries(byEntity).sort(([a], [b]) => a.localeCompare(b))) {
  perEntity[entity] = {
    count: uuids.length,
    sample: uuids.slice(0, 3),
  };
}

const anomalies = [];

// Check for duplicate UUID values (different keys pointing to the same UUID)
const allUuids = Object.values(idMap);
const uuidSet = new Set(allUuids);
if (uuidSet.size !== allUuids.length) {
  const dupeCount = allUuids.length - uuidSet.size;
  anomalies.push({
    type: "duplicate_uuid",
    message: `${dupeCount} duplicate UUID value(s) detected across different entity keys`,
  });
}

// Check for malformed keys (must contain exactly one colon)
const malformed = Object.keys(idMap).filter((k) => !k.includes(":"));
if (malformed.length > 0) {
  anomalies.push({
    type: "malformed_key",
    message: `${malformed.length} key(s) missing entity prefix: ${malformed.slice(0, 3).join(", ")}`,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  totalEntries: allUuids.length,
  perEntity,
  anomalies,
};

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
const json = JSON.stringify(report, null, 2);
writeFileSync(REPORT_TMP, json, "utf8");
renameSync(REPORT_TMP, REPORT_PATH);

console.log(`Reconciliation report written to ${REPORT_PATH}`);
console.log(`Total entries: ${report.totalEntries}`);
console.log("Per entity:");
for (const [entity, info] of Object.entries(perEntity)) {
  console.log(`  ${entity}: ${info.count}`);
}
if (anomalies.length > 0) {
  console.warn(`Anomalies detected: ${anomalies.length}`);
  for (const a of anomalies) {
    console.warn(`  [${a.type}] ${a.message}`);
  }
  process.exit(1);
} else {
  console.log("No anomalies detected.");
}
