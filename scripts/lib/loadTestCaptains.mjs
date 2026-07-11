// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  CLUB_COUNT,
  FIXTURE_PILOT_PASSWORD,
  LOADTEST_SLOTS_PER_TEAM,
  LOADTEST_TEAMS,
  PILOT_COUNT,
} from "./loadTestConsts.mjs";
import { loginLoadTestUser } from "./loadTestApi.mjs";
import { validateLoadTestManifest } from "./loadTestTopology.mjs";

export class LoadTestCaptainsError extends Error {
  constructor(message) {
    super(`[loadtest-captains] ${message}`);
    this.name = "LoadTestCaptainsError";
  }
}

function fail(message) {
  throw new LoadTestCaptainsError(message);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    fail(`${label} has unexpected keys`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

export function parsePreparedRound(prepared, manifest, expectedSeasonYear) {
  validateLoadTestManifest(manifest, expectedSeasonYear);
  exactKeys(
    prepared,
    ["baseUrl", "isAzureTarget", "roundId", "seasonYear", "siteId", "teams"],
    "prepared round",
  );
  const roundId = nonEmptyString(prepared.roundId, "prepared roundId");
  nonEmptyString(prepared.siteId, "prepared siteId");
  nonEmptyString(prepared.baseUrl, "prepared baseUrl");
  if (prepared.seasonYear !== expectedSeasonYear) fail("prepared season does not match fixture season");
  if (typeof prepared.isAzureTarget !== "boolean") fail("prepared isAzureTarget must be boolean");
  if (!manifest.siteIds.includes(prepared.siteId)) fail("prepared site is not fixture-owned");
  if (!Array.isArray(prepared.teams) || prepared.teams.length !== PILOT_COUNT) {
    fail(`prepared teams must contain exactly ${PILOT_COUNT} pilot slots`);
  }

  const canonicalByPilot = new Map(manifest.pilots.map((pilot) => [pilot.id, pilot]));
  const roundTeamByCanonical = new Map();
  const canonicalByRoundTeam = new Map();
  const seenPilots = new Set();
  const seenPlacesByTeam = new Map();
  for (const [index, slot] of prepared.teams.entries()) {
    exactKeys(slot, ["pilotEmail", "pilotId", "pilotPassword", "place", "teamId"], `prepared slot ${index}`);
    const pilotId = nonEmptyString(slot.pilotId, `prepared slot ${index} pilotId`);
    const teamId = nonEmptyString(slot.teamId, `prepared slot ${index} teamId`);
    const pilot = canonicalByPilot.get(pilotId);
    if (!pilot) fail(`prepared pilot ${pilotId} is not canonical`);
    if (seenPilots.has(pilotId)) fail(`prepared pilot ${pilotId} is duplicated`);
    seenPilots.add(pilotId);
    if (slot.pilotEmail !== pilot.email || slot.pilotPassword !== FIXTURE_PILOT_PASSWORD) {
      fail(`prepared pilot ${pilotId} credentials do not match fixture topology`);
    }
    if (!Number.isInteger(slot.place) || slot.place < 1 || slot.place > LOADTEST_SLOTS_PER_TEAM) {
      fail(`prepared pilot ${pilotId} place is invalid`);
    }
    const knownRoundTeamId = roundTeamByCanonical.get(pilot.clubTeamId);
    if (knownRoundTeamId !== undefined && knownRoundTeamId !== teamId) {
      fail(`prepared canonical team ${pilot.clubTeamId} maps to multiple round teams`);
    }
    const knownCanonicalTeamId = canonicalByRoundTeam.get(teamId);
    if (knownCanonicalTeamId !== undefined && knownCanonicalTeamId !== pilot.clubTeamId) {
      fail(`prepared round team ${teamId} has conflicting canonical team ownership`);
    }
    roundTeamByCanonical.set(pilot.clubTeamId, teamId);
    canonicalByRoundTeam.set(teamId, pilot.clubTeamId);
    const places = seenPlacesByTeam.get(teamId) ?? new Set();
    if (places.has(slot.place)) fail(`prepared round team ${teamId} has duplicate place ${slot.place}`);
    places.add(slot.place);
    seenPlacesByTeam.set(teamId, places);
  }
  if (roundTeamByCanonical.size !== LOADTEST_TEAMS || seenPlacesByTeam.size !== LOADTEST_TEAMS) {
    fail(`prepared topology must map exactly ${LOADTEST_TEAMS} round teams`);
  }
  for (const places of seenPlacesByTeam.values()) {
    if (places.size !== LOADTEST_SLOTS_PER_TEAM) fail("prepared round team must contain exactly 10 places");
  }
  return { roundId, roundTeamByCanonical };
}

function reconcileRound(round, manifest, preparedTopology) {
  if (round?.id !== preparedTopology.roundId || round?.status !== "Confirmed") {
    fail("authoritative round must be the prepared Confirmed round");
  }
  if (!Array.isArray(round.teams) || round.teams.length !== LOADTEST_TEAMS) {
    fail(`authoritative round must contain exactly ${LOADTEST_TEAMS} teams`);
  }
  const teamById = new Map(round.teams.map((team) => [team?.id, team]));
  if (teamById.size !== LOADTEST_TEAMS) fail("authoritative round team IDs must be unique");
  const authoritativeByPilot = new Map();
  const seenPlaces = new Set();
  for (const canonicalTeam of manifest.teams) {
    const roundTeamId = preparedTopology.roundTeamByCanonical.get(canonicalTeam.id);
    const roundTeam = teamById.get(roundTeamId);
    if (!roundTeam) fail(`authoritative canonical team ${canonicalTeam.id} is missing`);
    if (roundTeam.club?.id !== canonicalTeam.clubId || roundTeam.teamName !== canonicalTeam.teamName) {
      fail(`authoritative team ${roundTeamId} has wrong club or name`);
    }
    if (!Array.isArray(roundTeam.pilots) || roundTeam.pilots.length !== LOADTEST_SLOTS_PER_TEAM) {
      fail(`authoritative team ${roundTeamId} must contain exactly 10 slots`);
    }
    const expectedPilots = new Set(
      manifest.pilots.filter((pilot) => pilot.clubTeamId === canonicalTeam.id).map((pilot) => pilot.id),
    );
    for (const slot of roundTeam.pilots) {
      if (slot?.status !== "Filled" || !expectedPilots.has(slot.pilotId)) {
        fail(`authoritative team ${roundTeamId} contains a missing or foreign pilot`);
      }
      if (!Number.isInteger(slot.placeInTeam) || slot.placeInTeam < 1 || slot.placeInTeam > LOADTEST_SLOTS_PER_TEAM) {
        fail(`authoritative pilot ${slot.pilotId} has invalid place`);
      }
      const placeKey = `${roundTeamId}:${slot.placeInTeam}`;
      if (seenPlaces.has(placeKey)) fail(`authoritative place ${placeKey} is duplicated`);
      if (authoritativeByPilot.has(slot.pilotId)) fail(`authoritative pilot ${slot.pilotId} is duplicated`);
      seenPlaces.add(placeKey);
      authoritativeByPilot.set(slot.pilotId, { teamId: roundTeamId, place: slot.placeInTeam });
    }
  }
  if (authoritativeByPilot.size !== PILOT_COUNT || seenPlaces.size !== PILOT_COUNT) {
    fail(`authoritative round must reconcile exactly ${PILOT_COUNT} unique pilots and places`);
  }
  return authoritativeByPilot;
}

function expectedCaptains(manifest, preparedTopology) {
  return manifest.teams.map((team) => {
    const captain = manifest.pilots.find(
      (pilot) => pilot.clubTeamId === team.id && pilot.teamLocalRank === 0,
    );
    if (!captain) fail(`canonical team ${team.id} has no rank-zero captain`);
    return {
      teamId: preparedTopology.roundTeamByCanonical.get(team.id),
      clubId: team.clubId,
      pilotId: captain.id,
    };
  });
}

export async function runCaptainPhase(options) {
  const { manifest, prepared, expectedSeasonYear, callApi, writePrepared } = options;
  const topology = parsePreparedRound(prepared, manifest, expectedSeasonYear);
  const tokensByClub = new Map();
  for (const coordinator of manifest.coordinators) {
    const token = await loginLoadTestUser(callApi, {
      email: coordinator.email,
      password: FIXTURE_PILOT_PASSWORD,
    });
    if (tokensByClub.has(coordinator.clubId)) fail(`multiple coordinators claim club ${coordinator.clubId}`);
    tokensByClub.set(coordinator.clubId, token);
  }
  if (tokensByClub.size !== CLUB_COUNT) fail(`expected ${CLUB_COUNT} coordinator clubs`);

  const readToken = tokensByClub.values().next().value;
  const initialRound = await callApi("GET", `/api/rounds/${topology.roundId}`, { token: readToken });
  reconcileRound(initialRound, manifest, topology);
  const captains = expectedCaptains(manifest, topology);
  for (const captain of captains) {
    const token = tokensByClub.get(captain.clubId);
    if (!token || !captain.teamId) fail(`missing coordinator or round team for club ${captain.clubId}`);
    const updatedTeam = await callApi(
      "PUT",
      `/api/rounds/${topology.roundId}/teams/${captain.teamId}/captain`,
      { token, body: { pilotId: captain.pilotId } },
    );
    if (updatedTeam?.id !== captain.teamId || updatedTeam?.captainPilotId !== captain.pilotId) {
      fail(`captain PUT response mismatch for team ${captain.teamId}`);
    }
  }

  const finalRound = await callApi("GET", `/api/rounds/${topology.roundId}`, { token: readToken });
  const finalAuthoritativeByPilot = reconcileRound(finalRound, manifest, topology);
  const finalByTeam = new Map(finalRound?.teams?.map((team) => [team.id, team]));
  for (const captain of captains) {
    if (finalByTeam.get(captain.teamId)?.captainPilotId !== captain.pilotId) {
      fail(`final captain mismatch for team ${captain.teamId}`);
    }
  }
  const reconciled = {
    ...prepared,
    teams: prepared.teams.map((slot) => {
      const authoritative = finalAuthoritativeByPilot.get(slot.pilotId);
      if (!authoritative) fail(`authoritative pilot ${slot.pilotId} disappeared before rewrite`);
      return { ...slot, teamId: authoritative.teamId, place: authoritative.place };
    }),
  };
  await writePrepared(reconciled);
  return { coordinators: tokensByClub.size, captains: captains.length, slots: finalAuthoritativeByPilot.size };
}
