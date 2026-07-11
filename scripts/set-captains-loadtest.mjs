#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/** Assign canonical captains and reconcile prepared places from the authoritative round. */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createLoadTestApi } from "./lib/loadTestApi.mjs";
import { runCaptainPhase } from "./lib/loadTestCaptains.mjs";
import {
  BCC_API_BASE_URL,
  FIXTURE_MANIFEST_PATH,
  PREPARED_ROUND_PATH,
  SEASON_YEAR,
} from "./lib/loadTestConsts.mjs";
import { writeJsonAtomically } from "./lib/loadTestRoundState.mjs";

const SETUP_DEADLINE_MS = 15 * 60 * 1_000;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function main(options = {}) {
  const {
    manifestPath = FIXTURE_MANIFEST_PATH,
    preparedPath = PREPARED_ROUND_PATH,
    baseUrl = BCC_API_BASE_URL,
    expectedSeasonYear = SEASON_YEAR,
    createApi = createLoadTestApi,
    writePrepared = (value) => writeJsonAtomically(preparedPath, value),
  } = options;
  const manifest = await readJson(manifestPath);
  const prepared = await readJson(preparedPath);
  if (prepared?.baseUrl !== baseUrl) {
    throw new Error(`[set-captains-loadtest] prepared target ${prepared?.baseUrl} does not match ${baseUrl}`);
  }
  const callApi = createApi({ baseUrl, deadlineMs: Date.now() + SETUP_DEADLINE_MS });
  const result = await runCaptainPhase({
    manifest,
    prepared,
    expectedSeasonYear,
    callApi,
    writePrepared,
  });
  console.error(
    `[set-captains-loadtest] OK: coordinators=${result.coordinators} captains=${result.captains} slots=${result.slots}`,
  );
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
