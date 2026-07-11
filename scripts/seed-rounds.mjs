#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/** Seed four canonical, snapshotted browsing rounds through the production API. */

import { existsSync, readFileSync } from "node:fs";
import { cleanupOwnedRoundIds } from "./lib/loadTestRoundCleanup.mjs";
import { createLoadTestApi, loginLoadTestUser } from "./lib/loadTestApi.mjs";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD_OVERRIDE,
  BCC_API_BASE_URL,
  DEV_CREDENTIALS_PATH,
  FIXTURE_MANIFEST_PATH,
  FIXTURE_PILOT_PASSWORD,
  SEASON_YEAR,
} from "./lib/loadTestConsts.mjs";
import {
  appendSeedRoundId,
  readLoadTestRoundState,
  replaceSeedRoundIds,
  writeJsonAtomically,
} from "./lib/loadTestRoundState.mjs";
import { validateLoadTestManifest } from "./lib/loadTestTopology.mjs";

const TARGET_STATUSES = ["Proposed", "Confirmed", "BriefComplete", "Locked"];
const DATE_OFFSETS_DAYS = [7, 14, 21, 28];
const CLUBS_PER_ROUND = 4;
const PILOTS_PER_TEAM = 3;
const SETUP_DEADLINE_MS = 15 * 60 * 1_000;

function fail(message) {
  throw new Error(`[seed-rounds] ${message}`);
}

function resolveAdminPassword() {
  if (ADMIN_PASSWORD_OVERRIDE) return ADMIN_PASSWORD_OVERRIDE;
  if (existsSync(DEV_CREDENTIALS_PATH)) {
    const match = readFileSync(DEV_CREDENTIALS_PATH, "utf8").match(/^ADMIN_PASSWORD=(.+)$/m);
    if (match?.[1]) return match[1].trim();
  }
  fail("missing admin password; set ADMIN_PASSWORD or create .dev-credentials");
}

function isoDate(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function selectedTeamsAndPilots(manifest) {
  const teams = manifest.clubs.slice(0, CLUBS_PER_ROUND).map((club) => {
    const team = manifest.teams.find(
      (candidate) => candidate.clubId === club.id && candidate.teamName.endsWith(" Team A"),
    );
    if (!team) fail(`missing canonical Team A for ${club.name}`);
    const pilots = manifest.pilots
      .filter((pilot) => pilot.clubTeamId === team.id)
      .sort((left, right) => left.teamLocalRank - right.teamLocalRank)
      .slice(0, PILOTS_PER_TEAM);
    if (pilots.length !== PILOTS_PER_TEAM) fail(`missing pilots for ${team.teamName}`);
    return { team, pilots };
  });
  return { teams, pilots: teams.flatMap(({ pilots }) => pilots) };
}

async function persistSeedOwnership(manifest, roundId) {
  await appendSeedRoundId(roundId);
  const roundIds = Array.isArray(manifest.roundIds) ? manifest.roundIds : [];
  if (!roundIds.includes(roundId)) roundIds.push(roundId);
  manifest.roundIds = roundIds;
  await writeJsonAtomically(FIXTURE_MANIFEST_PATH, manifest);
}

async function replacePriorRounds(manifest) {
  const state = await readLoadTestRoundState();
  const manifestIds = Array.isArray(manifest.roundIds) ? manifest.roundIds : [];
  const priorIds = [...new Set([...state.seedRoundIds, ...manifestIds])];
  await cleanupOwnedRoundIds(priorIds, { seasonYears: [manifest.seasonYear] });
  await replaceSeedRoundIds([]);
  manifest.roundIds = [];
  await writeJsonAtomically(FIXTURE_MANIFEST_PATH, manifest);
}

async function transitionRound(callApi, token, roundId, targetStatus) {
  if (targetStatus !== "Proposed") {
    await callApi("POST", `/api/rounds/${roundId}/confirm`, { token, body: {} });
  }
  if (targetStatus === "BriefComplete" || targetStatus === "Locked") {
    await callApi("POST", `/api/rounds/${roundId}/brief-complete`, { token, body: {} });
  }
  if (targetStatus === "Locked") {
    await callApi("POST", `/api/rounds/${roundId}/lock`, { token, body: {} });
  }
}

async function seedRound(callApi, manifest, adminToken, pilotTokens, selected, statusIndex) {
  const created = await callApi("POST", "/api/rounds", {
    token: adminToken,
    body: {
      date: isoDate(DATE_OFFSETS_DAYS[statusIndex]),
      siteId: manifest.siteIds[0],
      seasonYear: manifest.seasonYear,
      organisingClubId: selected.teams[0].team.clubId,
    },
  });
  if (typeof created?.id !== "string" || created.id.length === 0) fail("createRound response missing id");
  const roundId = created.id;
  await persistSeedOwnership(manifest, roundId);

  for (const { team, pilots } of selected.teams) {
    const round = await callApi("POST", `/api/rounds/${roundId}/teams`, {
      token: adminToken,
      body: { clubId: team.clubId, teamName: team.teamName },
    });
    const added = round?.teams?.find(
      (candidate) => candidate.club?.id === team.clubId && candidate.teamName === team.teamName,
    );
    if (typeof added?.id !== "string") fail(`team ${team.teamName} missing from API response`);
    for (const pilot of pilots) {
      await callApi("POST", `/api/rounds/${roundId}/register-self`, {
        token: pilotTokens.get(pilot.id),
        body: { teamId: added.id },
      });
    }
  }
  await transitionRound(callApi, adminToken, roundId, TARGET_STATUSES[statusIndex]);
}

async function main() {
  if (!existsSync(FIXTURE_MANIFEST_PATH)) fail("run 'make seed' first");
  const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST_PATH, "utf8"));
  validateLoadTestManifest(manifest, SEASON_YEAR);
  if (!Array.isArray(manifest.siteIds) || manifest.siteIds.length === 0) fail("canonical manifest has no siteIds");
  const selected = selectedTeamsAndPilots(manifest);
  await replacePriorRounds(manifest);

  const callApi = createLoadTestApi({
    baseUrl: BCC_API_BASE_URL,
    deadlineMs: Date.now() + SETUP_DEADLINE_MS,
  });
  const adminToken = await loginLoadTestUser(callApi, {
    email: ADMIN_EMAIL,
    password: resolveAdminPassword(),
  });
  const pilotTokens = new Map();
  for (const [index, pilot] of selected.pilots.entries()) {
    // Azure supplies `client-ip`; local Functions falls back to the right-most XFF hop.
    const headers = BCC_API_BASE_URL.startsWith("http://localhost") || BCC_API_BASE_URL.startsWith("http://127.")
      ? { "x-forwarded-for": `127.77.0.${index + 1}` }
      : {};
    const token = await loginLoadTestUser(callApi, {
      email: pilot.email,
      password: FIXTURE_PILOT_PASSWORD,
    }, headers);
    pilotTokens.set(pilot.id, token);
    console.error(`[seed-rounds] authenticated synthetic pilot ${pilot.email}`);
  }
  for (let statusIndex = 0; statusIndex < TARGET_STATUSES.length; statusIndex += 1) {
    await seedRound(callApi, manifest, adminToken, pilotTokens, selected, statusIndex);
  }
  console.error(`[seed-rounds] OK: 4 rounds (${TARGET_STATUSES.join("/")})`);
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
