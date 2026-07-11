// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";

import { deterministicUuid } from "../lib/blobSeed.mjs";
import {
  CLUB_COUNT,
  FIXTURE_CLUB_NAME,
  FIXTURE_PILOT_EMAIL_PATTERN,
  FIXTURE_TEAM_NAME,
  LOADTEST_SLOTS_PER_TEAM,
  LOADTEST_TEAMS,
  PILOT_COUNT,
  TEAMS_PER_CLUB,
} from "../lib/loadTestConsts.mjs";
import {
  buildLoadTestManifest,
  coordinatorPilotIndices,
  pilotTopologyAt,
  validateLoadTestManifest,
} from "../lib/loadTestTopology.mjs";

const TEST_SEASON_YEAR = 2031;
const TEST_SITE_NAMES = ["Site Alpha", "Site Bravo", "Site Charlie"];

function freshManifest() {
  return buildLoadTestManifest({
    seasonYear: TEST_SEASON_YEAR,
    siteNames: TEST_SITE_NAMES,
  });
}

test("baseline: fixture constants and canonical names remain observable", () => {
  // Given the pre-topology fixture exports
  const constants = {
    pilotCount: PILOT_COUNT,
    teamsPerClub: TEAMS_PER_CLUB,
    loadtestTeams: LOADTEST_TEAMS,
    slotsPerTeam: LOADTEST_SLOTS_PER_TEAM,
  };

  // When callers generate representative fixture identities
  const names = {
    firstEmail: FIXTURE_PILOT_EMAIL_PATTERN(1),
    lastEmail: FIXTURE_PILOT_EMAIL_PATTERN(500),
    firstClub: FIXTURE_CLUB_NAME(1),
    lastClub: FIXTURE_CLUB_NAME(50),
    firstTeam: FIXTURE_TEAM_NAME(1, 1),
    secondTeam: FIXTURE_TEAM_NAME(1, 2),
  };
  const firstClubId = deterministicUuid("fixture-club", "club1");
  const teamIds = [1, 2].map((teamNumber) =>
    deterministicUuid("fixture-club-team", `${firstClubId}-${teamNumber}`)
  );

  // Then the existing public contract is pinned before production changes
  assert.deepEqual(constants, {
    pilotCount: 500,
    teamsPerClub: 2,
    loadtestTeams: 50,
    slotsPerTeam: 10,
  });
  assert.deepEqual(names, {
    firstEmail: "pilot001@bcc.local",
    lastEmail: "pilot500@bcc.local",
    firstClub: "Club 01",
    lastClub: "Club 50",
    firstTeam: "Club 01 Team A",
    secondTeam: "Club 01 Team B",
  });
  assert.deepEqual(teamIds, [
    "dc486bd9-5966-58ea-ad45-d1f6dc2f93d9",
    "c5e1bdc7-f2d1-5d77-ad90-938dcd5a2811",
  ]);
});

test("exact topology uses 25 clubs for 500 pilots", () => {
  // Given the load-test topology constants
  const topology = {
    pilots: PILOT_COUNT,
    clubs: CLUB_COUNT,
    teamsPerClub: TEAMS_PER_CLUB,
    teams: LOADTEST_TEAMS,
    slotsPerTeam: LOADTEST_SLOTS_PER_TEAM,
  };

  // When the aggregate capacity is calculated
  const capacity = topology.teams * topology.slotsPerTeam;

  // Then the contract is exactly 500/25/2/10
  assert.deepEqual(topology, {
    pilots: 500,
    clubs: 25,
    teamsPerClub: 2,
    teams: 50,
    slotsPerTeam: 10,
  });
  assert.equal(capacity, topology.pilots);
});

test("pilot indexing follows contiguous club and team blocks", () => {
  // Given representative pilot boundaries
  const pilotIndices = [0, 9, 10, 19, 20, 499];

  // When each index is mapped into the topology
  const mappings = pilotIndices.map(pilotTopologyAt);

  // Then club, team, and local rank follow floor(i/20), floor(i/10), and i%10
  assert.deepEqual(mappings, [
    { clubIndex: 0, teamIndex: 0, teamLocalRank: 0 },
    { clubIndex: 0, teamIndex: 0, teamLocalRank: 9 },
    { clubIndex: 0, teamIndex: 1, teamLocalRank: 0 },
    { clubIndex: 0, teamIndex: 1, teamLocalRank: 9 },
    { clubIndex: 1, teamIndex: 2, teamLocalRank: 0 },
    { clubIndex: 24, teamIndex: 49, teamLocalRank: 9 },
  ]);
});

test("manifest construction exposes ordered canonical topology records", () => {
  // Given deterministic fixture inputs
  const manifest = freshManifest();

  // When the pure manifest is validated
  const aggregate = validateLoadTestManifest(manifest, TEST_SEASON_YEAR);

  // Then counts, canonical IDs, assignment order, and coordinators are exact
  assert.deepEqual(
    {
      seasonYear: aggregate.seasonYear,
      clubCount: aggregate.clubCount,
      teamCount: aggregate.teamCount,
      pilotCount: aggregate.pilotCount,
      coordinatorCount: aggregate.coordinatorCount,
    },
    {
      seasonYear: TEST_SEASON_YEAR,
      clubCount: 25,
      teamCount: 50,
      pilotCount: 500,
      coordinatorCount: 25,
    }
  );
  assert.deepEqual(coordinatorPilotIndices(), [
    0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240,
    260, 280, 300, 320, 340, 360, 380, 400, 420, 440, 460, 480,
  ]);
  assert.equal(manifest.teams[0].teamName, "Club 01 Team A");
  assert.equal(manifest.teams[49].teamName, "Club 25 Team B");
  assert.equal(manifest.pilots[0].clubId, manifest.clubs[0].id);
  assert.equal(manifest.pilots[9].clubTeamId, manifest.teams[0].id);
  assert.equal(manifest.pilots[10].clubTeamId, manifest.teams[1].id);
  assert.equal(manifest.pilots[499].clubId, manifest.clubs[24].id);
  assert.equal(manifest.pilots[499].clubTeamId, manifest.teams[49].id);
  assert.deepEqual(aggregate.clubIds, manifest.clubIds);
  assert.deepEqual(aggregate.teamIds, manifest.teamIds);
  assert.deepEqual(aggregate.pilotIds, manifest.pilotIds);
  assert.deepEqual(
    aggregate.coordinatorPilotIds,
    coordinatorPilotIndices().map((pilotIndex) => manifest.pilotIds[pilotIndex])
  );
});

const malformedCases = [
  {
    name: "wrong pilot count",
    mutate: (manifest) => manifest.pilots.pop(),
    error: /LOADTEST_TOPOLOGY_PILOTS_COUNT: expected 500 pilots, received 499/,
  },
  {
    name: "duplicate pilot",
    mutate: (manifest) => { manifest.pilots[1].id = manifest.pilots[0].id; },
    error: /LOADTEST_TOPOLOGY_DUPLICATE_PILOT_ID/,
  },
  {
    name: "duplicate team",
    mutate: (manifest) => { manifest.teams[1].id = manifest.teams[0].id; },
    error: /LOADTEST_TOPOLOGY_DUPLICATE_TEAM_ID/,
  },
  {
    name: "cross-club team",
    mutate: (manifest) => { manifest.teams[0].clubId = manifest.clubIds[1]; },
    error: /LOADTEST_TOPOLOGY_TEAM_CLUB_MISMATCH/,
  },
  {
    name: "non-canonical team identity",
    mutate: (manifest) => { manifest.teams[0].teamName = "Alternate Team"; },
    error: /LOADTEST_TOPOLOGY_TEAM_IDENTITY_MISMATCH/,
  },
  {
    name: "pilot club mismatch",
    mutate: (manifest) => { manifest.pilots[0].clubId = manifest.clubIds[1]; },
    error: /LOADTEST_TOPOLOGY_PILOT_CLUB_MISMATCH/,
  },
  {
    name: "pilot team mismatch",
    mutate: (manifest) => { manifest.pilots[0].clubTeamId = manifest.teamIds[1]; },
    error: /LOADTEST_TOPOLOGY_PILOT_TEAM_MISMATCH/,
  },
  {
    name: "pilot user mismatch",
    mutate: (manifest) => { manifest.pilots[0].userId = manifest.userIds[1]; },
    error: /LOADTEST_TOPOLOGY_PILOT_USER_MISMATCH/,
  },
  {
    name: "team season drift",
    mutate: (manifest) => { manifest.teams[0].seasonYear += 1; },
    error: /LOADTEST_TOPOLOGY_TEAM_SEASON_YEAR_MISMATCH/,
  },
  {
    name: "pilot season drift",
    mutate: (manifest) => { manifest.pilots[0].seasonYear += 1; },
    error: /LOADTEST_TOPOLOGY_PILOT_SEASON_YEAR_MISMATCH/,
  },
  {
    name: "manifest season drift",
    mutate: (manifest) => { manifest.seasonYear += 1; },
    error: /LOADTEST_TOPOLOGY_SEASON_YEAR_MISMATCH/,
  },
  {
    name: "coordinator drift",
    mutate: (manifest) => { manifest.coordinators[0].pilotIndex = 1; },
    error: /LOADTEST_TOPOLOGY_COORDINATOR_MISMATCH/,
  },
];

for (const malformedCase of malformedCases) {
  test(`validator rejects ${malformedCase.name}`, () => {
    // Given a fresh manifest with one malformed topology field
    const manifest = freshManifest();
    malformedCase.mutate(manifest);

    // When validation runs, then it fails with an actionable topology code
    assert.throws(
      () => validateLoadTestManifest(manifest, TEST_SEASON_YEAR),
      malformedCase.error
    );
  });
}

test("validator rejects a copied stale 50-club manifest", () => {
  // Given a valid manifest copied into the old 50-club shape
  const staleManifest = structuredClone(freshManifest());
  staleManifest.clubs.push(...structuredClone(staleManifest.clubs));
  staleManifest.clubIds.push(...staleManifest.clubIds);

  // When validation runs, then stale shape is rejected without external state
  assert.throws(
    () => validateLoadTestManifest(staleManifest, TEST_SEASON_YEAR),
    /LOADTEST_TOPOLOGY_CLUBS_COUNT: expected 25 clubs, received 50/
  );
});
