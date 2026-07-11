#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * wipe-fixtures.mjs
 *
 * Surgical, manifest-driven wipe for load-test fixtures.
 *
 * Safety rules:
 * - The manifest is authoritative; never scan blob prefixes.
 * - Missing blobs are fine; deleteBlob() is delete-if-exists.
 * - The admin user is preserved by omission: do not place admin IDs in the manifest.
 *
 * Season handling follows the T10 plan spec: filter `seasons.json`, then delete
 * or filter `seasons/{seasonYear}.json` depending on whether non-fixture rounds
 * remain.
 */

import {
  getPrivateContainer,
  getPublicContainer,
} from "./lib/blobSeed.mjs";
import {
  cleanupFixturesTransaction,
} from "./lib/fixtureCleanupTransaction.mjs";
import {
  readCleanupState,
  withFixtureOperationLock,
} from "./lib/fixtureOperation.mjs";
import { FIXTURE_MANIFEST_PATH } from "./lib/loadTestConsts.mjs";
import { readFileSync, existsSync } from "node:fs";

const privateContainer = getPrivateContainer();
const publicContainer = getPublicContainer();

async function main() {
  if (!existsSync(FIXTURE_MANIFEST_PATH)) {
    const checkpoint = await readCleanupState();
    if (!checkpoint) {
      console.error("[wipe-fixtures] no manifest; nothing to wipe");
      return;
    }
    const { ownership } = await cleanupFixturesTransaction(publicContainer, privateContainer, {
      manifest: checkpoint.manifest,
      retainedManifest: checkpoint.retainedManifest,
    });
    console.error(`[wipe-fixtures] OK: resumed ${ownership.pilotIds.length} pilots`);
    return;
  }

  const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST_PATH, "utf8"));
  const { ownership } = await cleanupFixturesTransaction(publicContainer, privateContainer, {
    manifest,
  });

  console.error(
    `[wipe-fixtures] OK: ${ownership.pilotIds.length} pilots / ${ownership.clubIds.length} clubs / ${ownership.teamIds.length} teams / ${ownership.roundIds.length} rounds / ${ownership.siteIds.length} sites removed`,
  );
}

withFixtureOperationLock(main).catch((err) => {
  console.error(`[wipe-fixtures] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
