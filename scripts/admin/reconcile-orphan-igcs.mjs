// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Reconcile raw IGC blobs left behind by a crash between upload and round commit.
 * Dry-run is the default; pass --delete only after reviewing the candidate paths.
 */

import {
  deleteBlob,
  getPrivateContainer,
  readJson,
} from "../lib/blobSeed.mjs";

const IGC_PREFIX = "flight-igcs/";
const ROUND_PREFIX = "rounds/";
const DEFAULT_OLDER_THAN_HOURS = 24;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

function printHelp() {
  console.log(`Usage: node scripts/admin/reconcile-orphan-igcs.mjs [options]

Find private flight-igcs blobs that no authoritative rounds/{id}.json blob
references and that are older than the safety threshold. The default is dry-run.

Options:
  --dry-run                  List eligible orphan paths without deleting (default)
  --delete                   Delete eligible orphan paths
  --older-than-hours <hours> Minimum blob age in hours (default: 24)
  --help                     Show this help`);
}

function parseArgs(argv) {
  let mode = "dry-run";
  let olderThanHours = DEFAULT_OLDER_THAN_HOURS;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--dry-run") {
      mode = "dry-run";
      continue;
    }
    if (argument === "--delete") {
      mode = "delete";
      continue;
    }
    if (argument === "--older-than-hours") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--older-than-hours requires a positive number");
      }
      olderThanHours = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (!Number.isFinite(olderThanHours) || olderThanHours <= 0) {
    throw new Error("--older-than-hours must be a positive number");
  }

  return { help: false, mode, olderThanHours };
}

async function collectReferencedIgcPaths(container) {
  const referencedPaths = new Set();
  let roundsScanned = 0;

  for await (const blob of container.listBlobsFlat({ prefix: ROUND_PREFIX })) {
    const roundFileName = blob.name.slice(ROUND_PREFIX.length);
    if (!roundFileName.endsWith(".json") || roundFileName.includes("/")) continue;
    const round = await readJson(container, blob.name);
    if (!round || !Array.isArray(round.teams)) {
      throw new Error(`Invalid authoritative round blob: ${blob.name}`);
    }

    roundsScanned += 1;
    for (const team of round.teams) {
      if (!team || !Array.isArray(team.pilots)) {
        throw new Error(`Invalid authoritative round blob: ${blob.name}`);
      }
      for (const pilot of team.pilots) {
        if (!pilot || typeof pilot !== "object") {
          throw new Error(`Invalid authoritative round blob: ${blob.name}`);
        }
        const flight = pilot.flight;
        if (flight !== null && flight !== undefined && typeof flight !== "object") {
          throw new Error(`Invalid authoritative round blob: ${blob.name}`);
        }
        const igcPath = flight?.igcPath;
        if (igcPath !== undefined && typeof igcPath !== "string") {
          throw new Error(`Invalid authoritative round blob: ${blob.name}`);
        }
        if (typeof igcPath === "string" && igcPath.startsWith(IGC_PREFIX)) {
          referencedPaths.add(igcPath);
        }
      }
    }
  }

  return { referencedPaths, roundsScanned };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const container = getPrivateContainer();
  const cutoff = Date.now() - options.olderThanHours * MILLISECONDS_PER_HOUR;
  const { referencedPaths, roundsScanned } =
    await collectReferencedIgcPaths(container);
  const candidates = [];
  let igcsScanned = 0;
  let referenced = 0;
  let recent = 0;
  let missingLastModified = 0;

  for await (const blob of container.listBlobsFlat({ prefix: IGC_PREFIX })) {
    igcsScanned += 1;
    if (referencedPaths.has(blob.name)) {
      referenced += 1;
    } else if (!blob.properties.lastModified) {
      missingLastModified += 1;
    } else if (blob.properties.lastModified.getTime() >= cutoff) {
      recent += 1;
    } else {
      candidates.push(blob.name);
    }
  }

  if (options.mode === "delete" && candidates.length > 0) {
    const refreshed = await collectReferencedIgcPaths(container);
    referencedPaths.clear();
    for (const path of refreshed.referencedPaths) referencedPaths.add(path);
  }

  let deleted = 0;
  let newlyReferenced = 0;
  for (const path of candidates) {
    if (referencedPaths.has(path)) {
      newlyReferenced += 1;
      continue;
    }
    if (options.mode === "delete") {
      await deleteBlob(container, path);
      deleted += 1;
      console.log(`[DELETE] ${path}`);
    } else {
      console.log(`[DRY-RUN] ${path}`);
    }
  }

  console.log("");
  console.log(`Mode: ${options.mode}`);
  console.log(`Safety threshold: ${options.olderThanHours} hours`);
  console.log(`Authoritative rounds scanned: ${roundsScanned}`);
  console.log(`IGC blobs scanned: ${igcsScanned}`);
  console.log(`Referenced IGC blobs: ${referenced + newlyReferenced}`);
  console.log(`Recent unreferenced blobs protected: ${recent}`);
  console.log(`Blobs without last-modified protected: ${missingLastModified}`);
  console.log(`Eligible orphan blobs: ${candidates.length - newlyReferenced}`);
  console.log(`Deleted: ${deleted}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[ERROR] IGC reconciliation failed: ${message}`);
  process.exitCode = 1;
});
