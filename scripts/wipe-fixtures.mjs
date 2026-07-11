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
  cleanupFixtureOwnership,
  parseFixtureOwnership,
} from "./lib/fixtureOwnership.mjs";
import { FIXTURE_MANIFEST_PATH, PREPARED_ROUND_PATH } from "./lib/loadTestConsts.mjs";
import { readFileSync, existsSync, unlinkSync } from "node:fs";

const privateContainer = getPrivateContainer();
const publicContainer = getPublicContainer();

async function main() {
  if (!existsSync(FIXTURE_MANIFEST_PATH)) {
    console.error("[wipe-fixtures] no manifest; nothing to wipe");
    process.exit(0);
  }

  const ownership = parseFixtureOwnership(
    JSON.parse(readFileSync(FIXTURE_MANIFEST_PATH, "utf8"))
  );
  await cleanupFixtureOwnership(publicContainer, privateContainer, { ownership });

  if (existsSync(FIXTURE_MANIFEST_PATH)) unlinkSync(FIXTURE_MANIFEST_PATH);
  if (existsSync(PREPARED_ROUND_PATH)) unlinkSync(PREPARED_ROUND_PATH);

  console.error(
    `[wipe-fixtures] OK: ${ownership.pilotIds.length} pilots / ${ownership.clubIds.length} clubs / ${ownership.teamIds.length} teams / ${ownership.roundIds.length} rounds / ${ownership.siteIds.length} sites removed`,
  );
}

main().catch((err) => {
  console.error(`[wipe-fixtures] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
