#!/usr/bin/env node
/**
 * seed-fixtures.mjs
 *
 * Bulk deterministic fixture generator for local load/integration testing.
 * Writes directly to Azurite/Azure Blob Storage; does not call the HTTP API.
 */

import {
  deleteBlob,
  deterministicUuid,
  getPrivateContainer,
  getPublicContainer,
  precomputeBcryptHash,
  readJson,
  writeJson,
} from "./lib/blobSeed.mjs";
import {
  CLUB_COUNT,
  FIXTURE_CLUB_NAME,
  FIXTURE_MANIFEST_PATH,
  FIXTURE_PILOT_EMAIL_PATTERN,
  FIXTURE_PILOT_PASSWORD,
  FIXTURE_TEAM_NAME,
  PILOT_COUNT,
  PREPARED_ROUND_PATH,
  SEASON_YEAR,
  TEAMS_PER_CLUB,
  TS_CS_VERSION,
} from "./lib/loadTestConsts.mjs";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const CHUNK_SIZE = 50;
const SITE_NAMES = ["Site Alpha", "Site Bravo", "Site Charlie"];
const DEFAULT_WING_FACTORS = {
  "EN A": 1.2,
  "EN B": 1.1,
  "EN C": 1.0,
  "EN D": 0.9,
};

async function inChunks(items, worker) {
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    await Promise.all(items.slice(i, i + CHUNK_SIZE).map(worker));
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sortedByNameThenId(items) {
  return [...items].sort((a, b) =>
    String(a.name ?? "").localeCompare(String(b.name ?? "")) ||
    String(a.id ?? "").localeCompare(String(b.id ?? ""))
  );
}

function buildManifest() {
  const siteIds = SITE_NAMES.map((name) => deterministicUuid("fixture-site", name));
  const clubIds = Array.from({ length: CLUB_COUNT }, (_, i) =>
    deterministicUuid("fixture-club", `club${i + 1}`)
  );
  const teamIds = clubIds.flatMap((clubId) =>
    Array.from({ length: TEAMS_PER_CLUB }, (_, i) =>
      deterministicUuid("fixture-club-team", `${clubId}-${i + 1}`)
    )
  );
  const pilotEmails = Array.from({ length: PILOT_COUNT }, (_, i) =>
    FIXTURE_PILOT_EMAIL_PATTERN(i + 1).toLowerCase()
  );
  const pilotIds = pilotEmails.map((email) => deterministicUuid("fixture-pilot", email));
  const userIds = pilotEmails.map((email) => deterministicUuid("fixture-user", email));

  return {
    seasonYear: SEASON_YEAR,
    siteIds,
    clubIds,
    teamIds,
    pilotIds,
    userIds,
  };
}

async function wipePriorFixtures(publicContainer, privateContainer, nextManifest) {
  if (!existsSync(FIXTURE_MANIFEST_PATH)) return;

  const manifest = JSON.parse(await readFile(FIXTURE_MANIFEST_PATH, "utf8"));
  const pilotIds = new Set(manifest.pilotIds ?? []);
  const userIds = new Set(manifest.userIds ?? []);
  const clubIds = new Set(manifest.clubIds ?? []);
  const teamIds = new Set(manifest.teamIds ?? []);
  const siteIds = new Set(manifest.siteIds ?? []);
  const roundIds = new Set(manifest.roundIds ?? []);
  const nextPilotIds = new Set(nextManifest.pilotIds ?? []);
  const nextUserIds = new Set(nextManifest.userIds ?? []);
  const nextClubIds = new Set(nextManifest.clubIds ?? []);
  const nextTeamIds = new Set(nextManifest.teamIds ?? []);
  const nextSiteIds = new Set(nextManifest.siteIds ?? []);

  const deleteJobs = [
    ...[...roundIds].flatMap((id) => [
      () => deleteBlob(privateContainer, `rounds/${id}.json`),
      () => deleteBlob(privateContainer, `round-briefs/${id}.json`),
      () => deleteBlob(privateContainer, `round-briefs/${id}.pdf`),
    ]),
    // Deterministic T8 IDs are overwritten below. Only delete stale IDs from an
    // older manifest shape; this keeps re-seed fast while still being surgical.
    ...[...pilotIds].filter((id) => !nextPilotIds.has(id)).map((id) => () => deleteBlob(privateContainer, `pilots/${id}.json`)),
    ...[...userIds].flatMap((id) =>
      nextUserIds.has(id) ? [] : [
        () => deleteBlob(privateContainer, `users/${id}.json`),
        () => deleteBlob(privateContainer, `auth/${id}.json`),
      ]
    ),
    ...[...clubIds].filter((id) => !nextClubIds.has(id)).map((id) => () => deleteBlob(privateContainer, `clubs/${id}.json`)),
    ...[...teamIds].filter((id) => !nextTeamIds.has(id)).map((id) => () => deleteBlob(privateContainer, `club-teams/${id}.json`)),
    ...[...siteIds].filter((id) => !nextSiteIds.has(id)).map((id) => () => deleteBlob(privateContainer, `sites/${id}.json`)),
  ];

  await inChunks(deleteJobs, (job) => job());

  const userIndex = (await readJson(privateContainer, "user-index.json")) ?? {};
  for (const [email, userId] of Object.entries(userIndex)) {
    if (userIds.has(userId)) delete userIndex[email];
  }
  await writeJson(privateContainer, "user-index.json", userIndex);

  const pilotEmailIndex = (await readJson(privateContainer, "pilot-email-index.json")) ?? {};
  for (const [email, pilotId] of Object.entries(pilotEmailIndex)) {
    if (pilotIds.has(pilotId)) delete pilotEmailIndex[email];
  }
  await writeJson(privateContainer, "pilot-email-index.json", pilotEmailIndex);

  const publicFilters = [
    ["pilots.json", pilotIds],
    ["clubs.json", clubIds],
    ["club-teams.json", teamIds],
    ["sites.json", siteIds],
    ["rounds.json", roundIds],
  ];
  for (const [path, ids] of publicFilters) {
    const arr = asArray(await readJson(publicContainer, path));
    await writeJson(publicContainer, path, arr.filter((item) => !ids.has(item?.id)));
  }

  const seasons = asArray(await readJson(publicContainer, "seasons.json"));
  await writeJson(
    publicContainer,
    "seasons.json",
    seasons.filter((season) => season?.year !== manifest.seasonYear)
  );
  if (manifest.seasonYear) {
    await deleteBlob(publicContainer, `seasons/${manifest.seasonYear}.json`);
  }

  if (existsSync(PREPARED_ROUND_PATH)) unlinkSync(PREPARED_ROUND_PATH);
  unlinkSync(FIXTURE_MANIFEST_PATH);
}

async function patchConfig(privateContainer) {
  const existing = (await readJson(privateContainer, "config.json")) ?? {};
  const config = {
    ...existing,
    maxTeamsInClub: 3,
    maxPilotsInTeam: 10,
    maxScoringPilotsInTeam: 5,
    flightDateValidationEnabled: false,
    // Fixture-only: lets the load-test's 500 pilots (sourced from 50 different
    // clubs by T8's round-robin assignment) auto-allocate to the load-test
    // round's organising club at first register-self. Production default is
    // missing (≈ false), which enforces strict pilot→club seasonal binding.
    autoAllocatePilotsToRoundClub: true,
    wingFactors: existing.wingFactors ?? DEFAULT_WING_FACTORS,
  };
  await writeJson(privateContainer, "config.json", config);
  return config;
}

async function main() {
  const startedAt = performance.now();
  const publicContainer = getPublicContainer();
  const privateContainer = getPrivateContainer();
  await Promise.all([
    publicContainer.createIfNotExists({ access: "blob" }),
    privateContainer.createIfNotExists(),
  ]);

  const manifest = buildManifest();
  const pilotPasswordHash = await precomputeBcryptHash(FIXTURE_PILOT_PASSWORD);
  await wipePriorFixtures(publicContainer, privateContainer, manifest);

  const now = new Date().toISOString();

  const siteSummaries = SITE_NAMES.map((name, index) => ({
    id: manifest.siteIds[index],
    name,
    status: "Active",
    clubId: manifest.clubIds[0],
  }));
  await inChunks(siteSummaries, (site) =>
    writeJson(privateContainer, `sites/${site.id}.json`, { ...site, createdAt: now, updatedAt: now })
  );

  const seasonSummary = { id: String(SEASON_YEAR), year: SEASON_YEAR, active: true };
  const season = {
    ...seasonSummary,
    name: `BCC ${SEASON_YEAR}`,
    startDate: `${SEASON_YEAR}-04-01`,
    endDate: `${SEASON_YEAR}-10-31`,
    rounds: [],
    leagueTable: [],
  };

  await patchConfig(privateContainer);

  const clubs = Array.from({ length: CLUB_COUNT }, (_, i) => {
    const clubN = i + 1;
    return {
      id: manifest.clubIds[i],
      name: FIXTURE_CLUB_NAME(clubN),
      sites: [manifest.siteIds[0]],
      teams: [],
      createdAt: now,
      updatedAt: now,
    };
  });
  await inChunks(clubs, (club) => writeJson(privateContainer, `clubs/${club.id}.json`, club));

  const clubTeams = clubs.flatMap((club, clubIndex) =>
    Array.from({ length: TEAMS_PER_CLUB }, (_, teamIndex) => ({
      id: manifest.teamIds[clubIndex * TEAMS_PER_CLUB + teamIndex],
      clubId: club.id,
      clubName: club.name,
      seasonYear: SEASON_YEAR,
      teamName: FIXTURE_TEAM_NAME(clubIndex + 1, teamIndex + 1),
      createdAt: now,
    }))
  );
  await inChunks(clubTeams, (team) => writeJson(privateContainer, `club-teams/${team.id}.json`, team));

  const userIndexEntries = {};
  const pilotEmailIndexEntries = {};
  const pilots = Array.from({ length: PILOT_COUNT }, (_, i) => {
    const n = i + 1;
    const email = FIXTURE_PILOT_EMAIL_PATTERN(n).toLowerCase();
    const pilotId = manifest.pilotIds[i];
    const userId = manifest.userIds[i];
    const clubIndex = (n - 1) % CLUB_COUNT;
    const clubId = manifest.clubIds[clubIndex];
    const clubName = FIXTURE_CLUB_NAME(clubIndex + 1);
    const lastName = `P${String(n).padStart(3, "0")}`;
    const fullName = `Pilot ${lastName}`;

    userIndexEntries[email] = userId;
    pilotEmailIndexEntries[email] = pilotId;

    return {
      privatePilot: {
        id: pilotId,
        coachType: "None",
        pilotRating: "Pilot",
        person: {
          id: pilotId,
          firstName: "Pilot",
          lastName,
          fullName,
        },
        currentClub: { id: clubId, name: clubName },
        seasonClubs: [{ seasonYear: SEASON_YEAR, clubId, clubName, clubTeamId: null }],
        userId,
        profileUpdatedAt: now,
      },
      auth: {
        passwordHash: pilotPasswordHash,
        emailVerified: true,
        createdAt: now,
      },
      user: {
        id: userId,
        email,
        roles: ["Pilot"],
        pilotId,
        clubId,
        createdAt: now,
        acceptedTsCsVersion: TS_CS_VERSION,
      },
      summary: {
        id: pilotId,
        name: fullName,
        clubId,
        rating: "Pilot",
      },
    };
  });

  const pilotWriteJobs = pilots.flatMap((pilot) => [
    () => writeJson(privateContainer, `pilots/${pilot.privatePilot.id}.json`, pilot.privatePilot),
    () => writeJson(privateContainer, `auth/${pilot.user.id}.json`, pilot.auth),
    () => writeJson(privateContainer, `users/${pilot.user.id}.json`, pilot.user),
  ]);
  await inChunks(pilotWriteJobs, (job) => job());

  await writeJson(privateContainer, "user-index.json", {
    ...((await readJson(privateContainer, "user-index.json")) ?? {}),
    ...userIndexEntries,
  });
  await writeJson(privateContainer, "pilot-email-index.json", {
    ...((await readJson(privateContainer, "pilot-email-index.json")) ?? {}),
    ...pilotEmailIndexEntries,
  });

  await Promise.all([
    writeJson(publicContainer, "pilots.json", sortedByNameThenId(pilots.map((p) => p.summary))),
    writeJson(publicContainer, "clubs.json", sortedByNameThenId(clubs.map(({ id, name }) => ({ id, name })))),
    writeJson(publicContainer, "club-teams.json", clubTeams.map(({ id, clubId, clubName, seasonYear, teamName }) => ({ id, clubId, clubName, seasonYear, teamName })).sort((a, b) => {
      if (b.seasonYear !== a.seasonYear) return b.seasonYear - a.seasonYear;
      if (a.clubName !== b.clubName) return a.clubName.localeCompare(b.clubName);
      return a.teamName.localeCompare(b.teamName);
    })),
    writeJson(publicContainer, "sites.json", sortedByNameThenId(siteSummaries)),
    writeJson(publicContainer, "seasons.json", [seasonSummary]),
    writeJson(publicContainer, `seasons/${SEASON_YEAR}.json`, season),
  ]);

  writeFileSync(FIXTURE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(2);
  process.stderr.write(
    `[seed-fixtures] OK: ${PILOT_COUNT} pilots / ${CLUB_COUNT} clubs / ${clubTeams.length} teams / ${siteSummaries.length} sites / season ${SEASON_YEAR} (${elapsedSeconds}s)\n`
  );
}

main().catch((err) => {
  process.stderr.write(`seed-fixtures: ${err?.stack ?? err?.message ?? String(err)}\n`);
  process.exit(1);
});
