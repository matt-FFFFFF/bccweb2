#!/usr/bin/env bash

set -euo pipefail

STATE_DIR=".migration-state"
STDOUT_PATH="$STATE_DIR/prod-dryrun-stdout.txt"
REPORT_PATH="$STATE_DIR/prod-dryrun-report.json"
PROD_SNAPSHOT_PATH="$STATE_DIR/prod-blob-snapshot.json"
PUBLIC_CONTAINER="${BLOB_CONTAINER:-data}"
PRIVATE_CONTAINER="${BLOB_PRIVATE_CONTAINER:-data-private}"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

mask_connection_string() {
  node -e '
    const value = process.argv[1] || "";
    console.log(value
      .replace(/Password=[^;]+/gi, "Password=***")
      .replace(/AccountKey=[^;]+/gi, "AccountKey=***")
      .replace(/SharedAccessSignature=[^?&"\x27\s]+/gi, "SharedAccessSignature=***"));
  ' "${1:-}"
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "missing required environment variable: $name"
  fi
}

if [[ "${PROD_DRY_RUN_CONFIRM:-}" != "YES" ]]; then
  fail "refusing production dry-run unless PROD_DRY_RUN_CONFIRM=YES"
fi

require_env PROD_SQL_CONN
require_env STAGING_BLOB_CONN

mkdir -p "$STATE_DIR"

STAGING_BLOB_CONN="$STAGING_BLOB_CONN" PUBLIC_CONTAINER="$PUBLIC_CONTAINER" PRIVATE_CONTAINER="$PRIVATE_CONTAINER" node --input-type=module - <<'NODE'
import { BlobServiceClient } from "@azure/storage-blob";

const svc = BlobServiceClient.fromConnectionString(process.env.STAGING_BLOB_CONN);
await svc.getContainerClient(process.env.PUBLIC_CONTAINER).createIfNotExists({ access: "blob" });
await svc.getContainerClient(process.env.PRIVATE_CONTAINER).createIfNotExists();
NODE

printf '=== BCC production migration dry-run ===\n'
printf 'SQL source: %s\n' "$(mask_connection_string "$PROD_SQL_CONN")"
printf 'Staging blob target: %s\n' "$(mask_connection_string "$STAGING_BLOB_CONN")"
if [[ -n "${PROD_BLOB_CONN:-}" ]]; then
  printf 'Production blob comparison: %s\n' "$(mask_connection_string "$PROD_BLOB_CONN")"
else
  printf 'Production blob comparison: skipped (PROD_BLOB_CONN not set)\n'
fi
printf '\n'

printf 'Step 1/6: verifying SQL connectivity with SELECT 1...\n'
PROD_SQL_CONN="$PROD_SQL_CONN" node --input-type=module - <<'NODE'
import sql from "mssql";

const pool = await sql.connect(process.env.PROD_SQL_CONN);
try {
  const result = await pool.request().query("SELECT 1 AS ok");
  if (result.recordset?.[0]?.ok !== 1) throw new Error("SELECT 1 did not return ok=1");
} finally {
  await pool.close();
}
NODE

printf 'Step 2/6: BACPAC restore handling...\n'
if [[ -n "${BACPAC_PATH:-}" ]]; then
  if [[ ! -f "$BACPAC_PATH" ]]; then
    fail "BACPAC_PATH is set but file does not exist: $BACPAC_PATH"
  fi
  if command -v sqlpackage >/dev/null 2>&1; then
    if [[ -z "${BACPAC_TARGET_CONN:-}" ]]; then
      printf 'sqlpackage found, but BACPAC_TARGET_CONN is not set. Manual restore required before continuing.\n' >&2
      printf 'Example: sqlpackage /Action:Import /SourceFile:"%s" /TargetConnectionString:"<restored-db-conn>"\n' "$BACPAC_PATH" >&2
      fail "set BACPAC_TARGET_CONN to allow automated BACPAC restore"
    fi
    sqlpackage /Action:Import /SourceFile:"$BACPAC_PATH" /TargetConnectionString:"$BACPAC_TARGET_CONN"
    PROD_SQL_CONN="$BACPAC_TARGET_CONN"
    printf 'BACPAC restored; continuing against BACPAC_TARGET_CONN.\n'
  else
    printf 'sqlpackage is not installed. Manual restore required before continuing.\n' >&2
    printf 'Restore %s to a read-only SQL database, then rerun with PROD_SQL_CONN pointing at that database.\n' "$BACPAC_PATH" >&2
    fail "cannot restore BACPAC automatically without sqlpackage"
  fi
else
  printf 'No BACPAC_PATH provided; using PROD_SQL_CONN read-only snapshot/source.\n'
fi

printf 'Step 3/6: running migrate.mjs --dry-run --force-production against staging blob connection...\n'
SQL_CONNECTION_STRING="$PROD_SQL_CONN" \
BLOB_CONNECTION_STRING="$STAGING_BLOB_CONN" \
BLOB_CONTAINER="$PUBLIC_CONTAINER" \
BLOB_PRIVATE_CONTAINER="$PRIVATE_CONTAINER" \
PRODUCTION_CONFIRM=YES \
node scripts/migrate/migrate.mjs --dry-run --force-production > "$STDOUT_PATH"
printf 'Migration dry-run stdout captured at %s\n' "$STDOUT_PATH"

printf 'Step 4/6: building production snapshot / expected-counts input...\n'
PROD_BLOB_CONN_VALUE="${PROD_BLOB_CONN:-}"
if [[ -n "$PROD_BLOB_CONN_VALUE" ]] && command -v az >/dev/null 2>&1; then
  PROD_BLOB_CONN="$PROD_BLOB_CONN_VALUE" PUBLIC_CONTAINER="$PUBLIC_CONTAINER" STDOUT_PATH="$STDOUT_PATH" PROD_SNAPSHOT_PATH="$PROD_SNAPSHOT_PATH" node --input-type=module - <<'NODE'
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const conn = process.env.PROD_BLOB_CONN;
const container = process.env.PUBLIC_CONTAINER;
const stdout = process.env.STDOUT_PATH;
const out = process.env.PROD_SNAPSHOT_PATH;

function az(args, options = {}) {
  return execFileSync("az", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
}

function parsePlannedPaths(text) {
  return [...text.matchAll(/\[DRY\] would write ([^ ]+) \(/g)].map((m) => m[1]).sort();
}

function classify(path) {
  if (path === "clubs.json") return "clubIndex";
  if (path === "pilots.json") return "pilotIndex";
  if (path === "sites.json") return "siteIndex";
  if (path === "seasons.json") return "seasonIndex";
  if (path === "rounds.json") return "roundIndex";
  if (path.startsWith("seasons/")) return "seasonDetail";
  if (path.startsWith("results/")) return "result";
  if (path.startsWith("season-clubs/")) return "seasonClubIndex";
  return "other";
}

function tally(paths) {
  const counts = {};
  for (const path of paths) counts[classify(path)] = (counts[classify(path)] ?? 0) + 1;
  return counts;
}

function expectedEntityCounts(text) {
  const patterns = {
    manufacturer: /wrote\s+(\d+)\s+manufacturers\b/i,
    rating: /wrote\s+(\d+)\s+pilot ratings\b/i,
    club: /wrote\s+(\d+)\s+clubs\b/i,
    site: /wrote\s+(\d+)\s+sites\b/i,
    season: /wrote\s+(\d+)\s+seasons\b/i,
    pilot: /wrote\s+(\d+)\s+pilots\b/i,
    round: /wrote\s+(\d+)\s+rounds\b/i,
    frequency: /wrote\s+(\d+)\s+frequencies\b/i,
  };
  const counts = {};
  for (const [entity, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    if (match) counts[entity] = Number(match[1]);
  }
  return counts;
}

const listed = az([
  "storage", "blob", "list",
  "--connection-string", conn,
  "--container-name", container,
  "--query", "[].name",
  "-o", "tsv",
]);
const actualPaths = listed.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
const stdoutText = await import("node:fs").then((fs) => fs.readFileSync(stdout, "utf8"));
const plannedPaths = parsePlannedPaths(stdoutText);

writeFileSync(out, JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: "prod-blob-path-diff",
  publicContainer: container,
  expectedCounts: expectedEntityCounts(stdoutText),
  blobDiff: {
    plannedCounts: tally(plannedPaths),
    productionCounts: tally(actualPaths),
    plannedSample: plannedPaths.slice(0, 10),
    productionSample: actualPaths.slice(0, 10),
    missingInProdSample: plannedPaths.filter((p) => !actualPaths.includes(p)).slice(0, 10),
    extraInProdSample: actualPaths.filter((p) => !plannedPaths.includes(p)).slice(0, 10),
  },
}, null, 2) + "\n", "utf8");
NODE
elif [[ -n "$PROD_BLOB_CONN_VALUE" ]]; then
  printf 'az cli not found; production blob diff skipped. Falling back to dry-run stdout expected counts.\n' >&2
  STDOUT_PATH="$STDOUT_PATH" PROD_SNAPSHOT_PATH="$PROD_SNAPSHOT_PATH" node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const text = readFileSync(process.env.STDOUT_PATH, "utf8");
const patterns = {
  manufacturer: /wrote\s+(\d+)\s+manufacturers\b/i,
  rating: /wrote\s+(\d+)\s+pilot ratings\b/i,
  club: /wrote\s+(\d+)\s+clubs\b/i,
  site: /wrote\s+(\d+)\s+sites\b/i,
  season: /wrote\s+(\d+)\s+seasons\b/i,
  pilot: /wrote\s+(\d+)\s+pilots\b/i,
  round: /wrote\s+(\d+)\s+rounds\b/i,
  frequency: /wrote\s+(\d+)\s+frequencies\b/i,
};
const expectedCounts = {};
for (const [entity, pattern] of Object.entries(patterns)) {
  const match = text.match(pattern);
  if (match) expectedCounts[entity] = Number(match[1]);
}
writeFileSync(process.env.PROD_SNAPSHOT_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: "dry-run-stdout-counts",
  expectedCounts,
}, null, 2) + "\n", "utf8");
NODE
else
  STDOUT_PATH="$STDOUT_PATH" PROD_SNAPSHOT_PATH="$PROD_SNAPSHOT_PATH" node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const text = readFileSync(process.env.STDOUT_PATH, "utf8");
const patterns = {
  manufacturer: /wrote\s+(\d+)\s+manufacturers\b/i,
  rating: /wrote\s+(\d+)\s+pilot ratings\b/i,
  club: /wrote\s+(\d+)\s+clubs\b/i,
  site: /wrote\s+(\d+)\s+sites\b/i,
  season: /wrote\s+(\d+)\s+seasons\b/i,
  pilot: /wrote\s+(\d+)\s+pilots\b/i,
  round: /wrote\s+(\d+)\s+rounds\b/i,
  frequency: /wrote\s+(\d+)\s+frequencies\b/i,
};
const expectedCounts = {};
for (const [entity, pattern] of Object.entries(patterns)) {
  const match = text.match(pattern);
  if (match) expectedCounts[entity] = Number(match[1]);
}
writeFileSync(process.env.PROD_SNAPSHOT_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: "dry-run-stdout-counts",
  expectedCounts,
}, null, 2) + "\n", "utf8");
NODE
fi
printf 'Snapshot input written to %s\n' "$PROD_SNAPSHOT_PATH"

printf 'Step 5/6: running reconcile.mjs --against-prod-snapshot...\n'
PROD_SQL_CONN="$PROD_SQL_CONN" PROD_BLOB_CONN="${PROD_BLOB_CONN:-}" \
node scripts/migrate/reconcile.mjs --against-prod-snapshot "$PROD_SNAPSHOT_PATH"

printf 'Step 6/6: running privacy-scan.mjs against staging public blobs...\n'
BLOB_CONTAINER_NAME="$PUBLIC_CONTAINER" node scripts/privacy-scan.mjs --source "$STAGING_BLOB_CONN"

printf '\n=== Production dry-run summary ===\n'
node --input-type=module - <<'NODE'
import { readFileSync } from "node:fs";
const report = JSON.parse(readFileSync(".migration-state/prod-dryrun-report.json", "utf8"));
console.log(`Report: .migration-state/prod-dryrun-report.json`);
console.log(`Generated: ${report.generatedAt}`);
console.log("Per-entity counts:");
for (const [entity, info] of Object.entries(report.perEntity ?? {})) {
  console.log(`  ${entity}: ${info.count}`);
}
console.log(`Anomalies: ${(report.anomalies ?? []).length}`);
for (const anomaly of report.anomalies ?? []) {
  console.log(`  [${anomaly.type}] ${anomaly.message}`);
}
console.log(`Discarded: ${JSON.stringify(report.discarded ?? {})}`);
console.log("PII findings: none (privacy-scan passed)");
NODE

[[ -f "$REPORT_PATH" ]] || fail "expected report missing: $REPORT_PATH"
printf 'Production migration dry-run completed successfully.\n'
