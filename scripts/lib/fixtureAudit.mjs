// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { readJson } from "./blobSeed.mjs";
import { validateLoadTestManifest } from "./loadTestTopology.mjs";

function fail(code, detail) {
  throw new Error(`FIXTURE_AUDIT_${code}: ${detail}`);
}

async function readRequired(container, path) {
  const value = await readJson(container, path);
  if (value === null) fail("MISSING_BLOB", `${path} is missing`);
  return value;
}

async function inChunks(items, worker) {
  const results = [];
  for (let index = 0; index < items.length; index += 50) {
    results.push(...await Promise.all(items.slice(index, index + 50).map(worker)));
  }
  return results;
}

function exactOwnedIndex(index, ownedIds, label) {
  if (!Array.isArray(index)) fail(`${label}_INDEX_TYPE`, `${label} index must be an array`);
  const counts = new Map();
  for (const { id } of index) {
    if (ownedIds.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (counts.size !== ownedIds.size || [...counts.values()].some((count) => count !== 1)) {
    fail(`${label}_INDEX_OWNERSHIP`, `${label} index must contain every fixture id exactly once`);
  }
}

export async function auditFixtureStorage(publicContainer, privateContainer, manifest) {
  const expected = validateLoadTestManifest(manifest, manifest.seasonYear);
  const [publicPilots, publicClubs, publicTeams, config, userIndex, pilotEmailIndex] = await Promise.all([
    readRequired(publicContainer, "pilots.json"),
    readRequired(publicContainer, "clubs.json"),
    readRequired(publicContainer, "club-teams.json"),
    readRequired(privateContainer, "config.json"),
    readRequired(privateContainer, "user-index.json"),
    readRequired(privateContainer, "pilot-email-index.json"),
  ]);
  exactOwnedIndex(publicPilots, new Set(expected.pilotIds), "PILOT");
  exactOwnedIndex(publicClubs, new Set(expected.clubIds), "CLUB");
  exactOwnedIndex(publicTeams, new Set(expected.teamIds), "TEAM");
  if (Object.hasOwn(config, "autoAllocatePilotsToRoundClub")) {
    fail("CONFIG_FLAG", "config contains removed fixture auto-allocation flag");
  }
  for (const pilot of manifest.pilots) {
    if (userIndex[pilot.email] !== pilot.userId) {
      fail("USER_INDEX", "fixture user index does not match manifest ownership");
    }
    if (pilotEmailIndex[pilot.email] !== pilot.id) {
      fail("PILOT_EMAIL_INDEX", "fixture pilot index does not match manifest ownership");
    }
  }

  const [storedClubs, storedTeams] = await Promise.all([
    inChunks(manifest.clubs, (club) =>
      readRequired(privateContainer, `clubs/${club.id}.json`)
    ),
    inChunks(manifest.teams, (team) =>
      readRequired(privateContainer, `club-teams/${team.id}.json`)
    ),
  ]);
  for (let index = 0; index < storedClubs.length; index += 1) {
    if (
      storedClubs[index].id !== manifest.clubs[index].id ||
      storedClubs[index].name !== manifest.clubs[index].name
    ) {
      fail("CLUB_MISMATCH", `stored club ${index} has incorrect identity`);
    }
  }
  for (let index = 0; index < storedTeams.length; index += 1) {
    const actual = storedTeams[index];
    const expectedTeam = manifest.teams[index];
    for (const key of ["id", "clubId", "clubName", "seasonYear", "teamName"]) {
      if (actual[key] !== expectedTeam[key]) {
        fail("TEAM_MISMATCH", `stored team ${index} has incorrect ${key}`);
      }
    }
  }

  const records = await inChunks(manifest.pilots, async (pilot) => ({
    pilot: await readRequired(privateContainer, `pilots/${pilot.id}.json`),
    user: await readRequired(privateContainer, `users/${pilot.userId}.json`),
    authExists: await privateContainer.getBlobClient(`auth/${pilot.userId}.json`).exists(),
  }));
  const coordinatorIds = new Set(manifest.coordinators.map(({ pilotId }) => pilotId));
  const pilotsPerTeam = new Map(manifest.teamIds.map((teamId) => [teamId, 0]));
  let coordinators = 0;
  for (let index = 0; index < records.length; index += 1) {
    const { pilot, user } = records[index];
    const expectedPilot = manifest.pilots[index];
    const seasonClub = pilot.seasonClubs?.[0];
    if (
      seasonClub?.seasonYear !== expectedPilot.seasonYear ||
      seasonClub?.clubId !== expectedPilot.clubId ||
      seasonClub?.clubTeamId !== expectedPilot.clubTeamId ||
      user.clubId !== expectedPilot.clubId
    ) {
      fail("PILOT_OWNERSHIP", `stored pilot ${index} has incorrect seasonal ownership`);
    }
    if (!records[index].authExists) {
      fail("MISSING_AUTH", `stored pilot ${index} has no auth record`);
    }
    pilotsPerTeam.set(
      expectedPilot.clubTeamId,
      (pilotsPerTeam.get(expectedPilot.clubTeamId) ?? 0) + 1
    );
    const expectedRoles = coordinatorIds.has(expectedPilot.id)
      ? ["Pilot", "RoundsCoord"]
      : ["Pilot"];
    if (JSON.stringify(user.roles) !== JSON.stringify(expectedRoles)) {
      fail("PILOT_ROLES", `stored pilot ${index} has incorrect roles`);
    }
    if (expectedRoles.length === 2) coordinators += 1;
  }
  if ([...pilotsPerTeam.values()].some((count) => count !== 10)) {
    fail("TEAM_PILOT_COUNT", "every fixture team must own exactly 10 pilots");
  }

  return {
    status: "pass",
    pilots: expected.pilotCount,
    clubs: expected.clubCount,
    teams: expected.teamCount,
    coordinators,
    pilotOnly: expected.pilotCount - coordinators,
  };
}
