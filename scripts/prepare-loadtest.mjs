#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/** Create the canonical 50-team load-test round through the production API. */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { cleanupOwnedRoundIds } from "./lib/loadTestRoundCleanup.mjs";
import { createLoadTestApi, loginLoadTestUser } from "./lib/loadTestApi.mjs";
import { resolveAdminPassword } from "./lib/devCredentials.mjs";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD_OVERRIDE,
  BCC_API_BASE_URL,
  FIXTURE_MANIFEST_PATH,
  FIXTURE_PILOT_PASSWORD,
  LOADTEST_SLOTS_PER_TEAM,
  LOADTEST_TEAMS,
  PREPARED_ROUND_PATH,
  SEASON_YEAR,
} from "./lib/loadTestConsts.mjs";
import {
  assertLoadRoundTarget,
  readLoadTestRoundState,
  setLoadRoundId,
  writeJsonAtomically,
} from "./lib/loadTestRoundState.mjs";
import { loadTestTargetIdentity } from "./lib/loadTestTargetIdentity.mjs";
import { validateLoadTestManifest } from "./lib/loadTestTopology.mjs";

const SETUP_DEADLINE_MS = 15 * 60 * 1_000;
const LOAD_ROUND_OFFSET_DAYS = 35;
const LOAD_TARGET = loadTestTargetIdentity(BCC_API_BASE_URL);

function fail(message) {
  throw new Error(`[prepare-loadtest] ${message}`);
}

function isoDatePlusDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function replacePriorLoadRound(manifest) {
  const state = await readLoadTestRoundState();
  assertLoadRoundTarget(state, LOAD_TARGET);
  if (state.loadRoundId === null) return;
  await cleanupOwnedRoundIds([state.loadRoundId], { seasonYears: [manifest.seasonYear] });
  await setLoadRoundId(null);
  if (existsSync(PREPARED_ROUND_PATH)) unlinkSync(PREPARED_ROUND_PATH);
}

function buildPreparedSlots(manifest, roundTeamIds) {
  return manifest.pilots.map((pilot) => {
    const teamId = roundTeamIds.get(pilot.clubTeamId);
    if (!teamId) fail(`missing round team for canonical team ${pilot.clubTeamId}`);
    return {
      teamId,
      place: pilot.teamLocalRank + 1,
      pilotEmail: pilot.email,
      pilotPassword: FIXTURE_PILOT_PASSWORD,
      pilotId: pilot.id,
    };
  });
}

async function main() {
  if (!existsSync(FIXTURE_MANIFEST_PATH)) fail("run 'make seed' first");
  const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST_PATH, "utf8"));
  validateLoadTestManifest(manifest, SEASON_YEAR);
  if (!Array.isArray(manifest.siteIds) || manifest.siteIds.length === 0) {
    fail("canonical manifest has no siteIds");
  }
  const adminPassword = resolveAdminPassword(ADMIN_PASSWORD_OVERRIDE);

  await replacePriorLoadRound(manifest);
  const callApi = createLoadTestApi({
    baseUrl: BCC_API_BASE_URL,
    deadlineMs: Date.now() + SETUP_DEADLINE_MS,
  });
  const token = await loginLoadTestUser(callApi, {
    email: ADMIN_EMAIL,
    password: adminPassword,
  });
  const siteId = manifest.siteIds[0];
  const created = await callApi("POST", "/api/rounds", {
    token,
    body: {
      date: isoDatePlusDays(LOAD_ROUND_OFFSET_DAYS),
      siteId,
      seasonYear: manifest.seasonYear,
      maxTeams: LOADTEST_TEAMS,
      organisingClubId: manifest.clubs[0].id,
    },
  });
  if (typeof created?.id !== "string" || created.id.length === 0) {
    fail("createRound response missing id");
  }
  const roundId = created.id;
  await setLoadRoundId(roundId, LOAD_TARGET);

  const startedAt = performance.now();
  const roundTeamIds = new Map();
  for (const team of manifest.teams) {
    const round = await callApi("POST", `/api/rounds/${roundId}/teams`, {
      token,
      body: { clubId: team.clubId, teamName: team.teamName },
    });
    const added = round?.teams?.find(
      (candidate) => candidate.club?.id === team.clubId && candidate.teamName === team.teamName,
    );
    if (typeof added?.id !== "string") fail(`team ${team.teamName} missing from API response`);
    roundTeamIds.set(team.id, added.id);
  }
  if (roundTeamIds.size !== LOADTEST_TEAMS) fail(`created ${roundTeamIds.size} teams`);

  const confirmed = await callApi("POST", `/api/rounds/${roundId}/confirm`, {
    token,
    body: {},
  });
  if (confirmed?.status !== "Confirmed") fail(`expected Confirmed, received ${confirmed?.status}`);
  const slots = buildPreparedSlots(manifest, roundTeamIds);
  if (slots.length !== LOADTEST_TEAMS * LOADTEST_SLOTS_PER_TEAM) {
    fail(`prepared ${slots.length} slots`);
  }
  await writeJsonAtomically(PREPARED_ROUND_PATH, {
    roundId,
    seasonYear: manifest.seasonYear,
    siteId,
    teams: slots,
    baseUrl: BCC_API_BASE_URL,
    isAzureTarget: !BCC_API_BASE_URL.startsWith("http://localhost") && !BCC_API_BASE_URL.startsWith("http://127."),
  });
  const teamsMs = Math.round(performance.now() - startedAt);
  console.error(`[prepare-loadtest] OK: round=${roundId} teams=50 slots=500 status=Confirmed teamsMs=${teamsMs}`);
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
