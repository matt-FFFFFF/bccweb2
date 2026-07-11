// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { deterministicUuid } from "./blobSeed.mjs";
import {
  CLUB_COUNT,
  FIXTURE_CLUB_NAME,
  FIXTURE_PILOT_EMAIL_PATTERN,
  FIXTURE_TEAM_NAME,
  LOADTEST_SLOTS_PER_TEAM,
  LOADTEST_TEAMS,
  PILOT_COUNT,
  TEAMS_PER_CLUB,
} from "./loadTestConsts.mjs";

const COORDINATOR_STRIDE = TEAMS_PER_CLUB * LOADTEST_SLOTS_PER_TEAM;

function fail(code, detail) {
  throw new Error(`LOADTEST_TOPOLOGY_${code}: ${detail}`);
}

function requireArray(manifest, key, count) {
  const value = manifest?.[key];
  if (!Array.isArray(value)) fail(`${key.toUpperCase()}_TYPE`, `${key} must be an array`);
  if (value.length !== count) {
    fail(`${key.toUpperCase()}_COUNT`, `expected ${count} ${key}, received ${value.length}`);
  }
  return value;
}

function requireUnique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = key === null ? item : item?.[key];
    if (typeof value !== "string" || value.length === 0) {
      fail(`${label}_ID`, `${label.toLowerCase()} id must be a non-empty string`);
    }
    if (seen.has(value)) fail(`DUPLICATE_${label}_ID`, `duplicate ${label.toLowerCase()} id ${value}`);
    seen.add(value);
  }
}

function requireIndexedIds(records, ids, label) {
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].id !== ids[index]) {
      fail(`${label}_ID_ORDER`, `${label.toLowerCase()} ${index} id does not match ${label.toLowerCase()}Ids`);
    }
  }
}

export function pilotTopologyAt(pilotIndex) {
  if (!Number.isInteger(pilotIndex) || pilotIndex < 0 || pilotIndex >= PILOT_COUNT) {
    fail("PILOT_INDEX", `pilot index must be an integer from 0 to ${PILOT_COUNT - 1}`);
  }
  return {
    clubIndex: Math.floor(pilotIndex / COORDINATOR_STRIDE),
    teamIndex: Math.floor(pilotIndex / LOADTEST_SLOTS_PER_TEAM),
    teamLocalRank: pilotIndex % LOADTEST_SLOTS_PER_TEAM,
  };
}

export function coordinatorPilotIndices() {
  return Array.from({ length: CLUB_COUNT }, (_, index) => index * COORDINATOR_STRIDE);
}

export function buildLoadTestManifest({ seasonYear, siteNames }) {
  const siteIds = siteNames.map((name) => deterministicUuid("fixture-site", name));
  const clubs = Array.from({ length: CLUB_COUNT }, (_, clubIndex) => {
    const clubNumber = clubIndex + 1;
    return {
      id: deterministicUuid("fixture-club", `club${clubNumber}`),
      name: FIXTURE_CLUB_NAME(clubNumber),
    };
  });
  const teams = clubs.flatMap((club, clubIndex) =>
    Array.from({ length: TEAMS_PER_CLUB }, (_, localTeamIndex) => ({
      id: deterministicUuid("fixture-club-team", `${club.id}-${localTeamIndex + 1}`),
      clubId: club.id,
      clubName: club.name,
      seasonYear,
      teamName: FIXTURE_TEAM_NAME(clubIndex + 1, localTeamIndex + 1),
    }))
  );
  const pilots = Array.from({ length: PILOT_COUNT }, (_, pilotIndex) => {
    const pilotNumber = pilotIndex + 1;
    const email = FIXTURE_PILOT_EMAIL_PATTERN(pilotNumber).toLowerCase();
    const topology = pilotTopologyAt(pilotIndex);
    return {
      id: deterministicUuid("fixture-pilot", email),
      userId: deterministicUuid("fixture-user", email),
      email,
      seasonYear,
      clubId: clubs[topology.clubIndex].id,
      clubName: clubs[topology.clubIndex].name,
      clubTeamId: teams[topology.teamIndex].id,
      teamName: teams[topology.teamIndex].teamName,
      teamLocalRank: topology.teamLocalRank,
    };
  });
  const coordinators = coordinatorPilotIndices().map((pilotIndex) => ({
    pilotIndex,
    pilotId: pilots[pilotIndex].id,
    userId: pilots[pilotIndex].userId,
    email: pilots[pilotIndex].email,
    clubId: pilots[pilotIndex].clubId,
  }));

  return {
    seasonYear,
    siteIds,
    clubIds: clubs.map(({ id }) => id),
    teamIds: teams.map(({ id }) => id),
    pilotIds: pilots.map(({ id }) => id),
    userIds: pilots.map(({ userId }) => userId),
    clubs,
    teams,
    pilots,
    coordinators,
  };
}

export function validateLoadTestManifest(manifest, expectedSeasonYear) {
  if (manifest?.seasonYear !== expectedSeasonYear) {
    fail("SEASON_YEAR_MISMATCH", `expected season ${expectedSeasonYear}, received ${manifest?.seasonYear}`);
  }
  const clubs = requireArray(manifest, "clubs", CLUB_COUNT);
  const teams = requireArray(manifest, "teams", LOADTEST_TEAMS);
  const pilots = requireArray(manifest, "pilots", PILOT_COUNT);
  const coordinators = requireArray(manifest, "coordinators", CLUB_COUNT);
  const clubIds = requireArray(manifest, "clubIds", CLUB_COUNT);
  const teamIds = requireArray(manifest, "teamIds", LOADTEST_TEAMS);
  const pilotIds = requireArray(manifest, "pilotIds", PILOT_COUNT);
  const userIds = requireArray(manifest, "userIds", PILOT_COUNT);

  for (const [items, key, label] of [
    [clubs, "id", "CLUB"], [teams, "id", "TEAM"], [pilots, "id", "PILOT"],
    [coordinators, "pilotId", "COORDINATOR_PILOT"], [clubIds, null, "CLUB"],
    [teamIds, null, "TEAM"], [pilotIds, null, "PILOT"], [userIds, null, "USER"],
  ]) requireUnique(items, key, label);
  requireIndexedIds(clubs, clubIds, "CLUB");
  requireIndexedIds(teams, teamIds, "TEAM");
  requireIndexedIds(pilots, pilotIds, "PILOT");

  for (let teamIndex = 0; teamIndex < teams.length; teamIndex += 1) {
    const expectedClub = clubs[Math.floor(teamIndex / TEAMS_PER_CLUB)];
    const team = teams[teamIndex];
    const localTeamNumber = (teamIndex % TEAMS_PER_CLUB) + 1;
    const expectedTeamId = deterministicUuid("fixture-club-team", `${expectedClub.id}-${localTeamNumber}`);
    const expectedTeamName = FIXTURE_TEAM_NAME(Math.floor(teamIndex / TEAMS_PER_CLUB) + 1, localTeamNumber);
    if (team.id !== expectedTeamId || team.teamName !== expectedTeamName) {
      fail("TEAM_IDENTITY_MISMATCH", `team ${teamIndex} must use canonical id and name`);
    }
    if (team.clubId !== expectedClub.id) fail("TEAM_CLUB_MISMATCH", `team ${team.id} must belong to club ${expectedClub.id}`);
    if (team.seasonYear !== expectedSeasonYear) fail("TEAM_SEASON_YEAR_MISMATCH", `team ${team.id} has season ${team.seasonYear}`);
  }
  for (let pilotIndex = 0; pilotIndex < pilots.length; pilotIndex += 1) {
    const topology = pilotTopologyAt(pilotIndex);
    const pilot = pilots[pilotIndex];
    const expectedClub = clubs[topology.clubIndex];
    const expectedTeam = teams[topology.teamIndex];
    if (pilot.userId !== userIds[pilotIndex]) fail("PILOT_USER_MISMATCH", `pilot ${pilot.id} user does not match userIds`);
    if (pilot.clubId !== expectedClub.id) fail("PILOT_CLUB_MISMATCH", `pilot ${pilot.id} must belong to club ${expectedClub.id}`);
    if (pilot.clubTeamId !== expectedTeam.id) fail("PILOT_TEAM_MISMATCH", `pilot ${pilot.id} must belong to team ${expectedTeam.id}`);
    if (pilot.teamLocalRank !== topology.teamLocalRank) fail("PILOT_LOCAL_RANK_MISMATCH", `pilot ${pilot.id} must have team-local rank ${topology.teamLocalRank}`);
    if (pilot.teamName !== expectedTeam.teamName) fail("PILOT_TEAM_NAME_MISMATCH", `pilot ${pilot.id} must use team name ${expectedTeam.teamName}`);
    if (pilot.seasonYear !== expectedSeasonYear) fail("PILOT_SEASON_YEAR_MISMATCH", `pilot ${pilot.id} has season ${pilot.seasonYear}`);
  }
  const expectedCoordinatorIndices = coordinatorPilotIndices();
  for (let index = 0; index < coordinators.length; index += 1) {
    const pilotIndex = expectedCoordinatorIndices[index];
    const coordinator = coordinators[index];
    const pilot = pilots[pilotIndex];
    if (
      coordinator.pilotIndex !== pilotIndex || coordinator.pilotId !== pilot.id ||
      coordinator.userId !== pilot.userId || coordinator.email !== pilot.email ||
      coordinator.clubId !== pilot.clubId
    ) {
      fail("COORDINATOR_MISMATCH", `coordinator ${index} must reference pilot index ${pilotIndex}`);
    }
  }

  return {
    seasonYear: manifest.seasonYear,
    clubCount: clubs.length,
    teamCount: teams.length,
    pilotCount: pilots.length,
    coordinatorCount: coordinators.length,
    clubIds: [...clubIds],
    teamIds: [...teamIds],
    pilotIds: [...pilotIds],
    coordinatorPilotIds: coordinators.map(({ pilotId }) => pilotId),
  };
}
