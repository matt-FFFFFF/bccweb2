// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  deleteBlob,
  deterministicUuid,
  writeJson,
} from "./blobSeed.mjs";
import {
  FIXTURE_PILOT_EMAIL_PATTERN,
  SEASON_YEAR,
  TEAMS_PER_CLUB,
} from "./loadTestConsts.mjs";
import { validateLoadTestManifest } from "./loadTestTopology.mjs";
import { preflightFixtureStorage } from "./fixtureStoragePreflight.mjs";

const SITE_NAMES = ["Site Alpha", "Site Bravo", "Site Charlie"];
const LEGACY_CLUB_COUNTS = new Set([25, 50]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(code, detail) {
  throw new Error(`FIXTURE_OWNERSHIP_${code}: ${detail}`);
}

function exactIds(manifest, key, expected) {
  const values = manifest?.[key];
  if (!Array.isArray(values) || values.length !== expected.length) {
    fail(`${key.toUpperCase()}_COUNT`, `${key} must contain exactly ${expected.length} ids`);
  }
  const unique = new Set(values);
  if (unique.size !== values.length) {
    fail(`${key.toUpperCase()}_DUPLICATE`, `${key} contains duplicate ids`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (values[index] !== expected[index]) {
      fail(`${key.toUpperCase()}_IDENTITY`, `${key}[${index}] is not a deterministic fixture id`);
    }
  }
  return [...values];
}

function optionalRoundIds(manifest) {
  const values = manifest.roundIds ?? [];
  if (!Array.isArray(values)) fail("ROUNDIDS_TYPE", "roundIds must be an array when present");
  if (new Set(values).size !== values.length) fail("ROUNDIDS_DUPLICATE", "roundIds contains duplicate ids");
  for (const value of values) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      fail("ROUNDIDS_IDENTITY", "roundIds must contain UUIDs");
    }
  }
  return [...values];
}

export function parseFixtureOwnership(manifest) {
  if (manifest?.seasonYear !== SEASON_YEAR) {
    fail("SEASON_YEAR", `seasonYear must be the fixture season ${SEASON_YEAR}`);
  }
  if (manifest.clubs !== undefined) {
    validateLoadTestManifest(manifest, manifest.seasonYear);
  }

  const clubCount = manifest.clubIds?.length;
  if (!LEGACY_CLUB_COUNTS.has(clubCount)) {
    fail("CLUBIDS_COUNT", "clubIds must contain an exact supported fixture generation");
  }
  const expectedClubIds = Array.from({ length: clubCount }, (_, index) =>
    deterministicUuid("fixture-club", `club${index + 1}`)
  );
  const expectedTeamIds = expectedClubIds.flatMap((clubId) =>
    Array.from({ length: TEAMS_PER_CLUB }, (_, index) =>
      deterministicUuid("fixture-club-team", `${clubId}-${index + 1}`)
    )
  );
  const emails = Array.from({ length: 500 }, (_, index) =>
    FIXTURE_PILOT_EMAIL_PATTERN(index + 1).toLowerCase()
  );

  return {
    seasonYear: manifest.seasonYear,
    siteIds: exactIds(
      manifest,
      "siteIds",
      SITE_NAMES.map((name) => deterministicUuid("fixture-site", name))
    ),
    clubIds: exactIds(manifest, "clubIds", expectedClubIds),
    teamIds: exactIds(manifest, "teamIds", expectedTeamIds),
    pilotIds: exactIds(
      manifest,
      "pilotIds",
      emails.map((email) => deterministicUuid("fixture-pilot", email))
    ),
    userIds: exactIds(
      manifest,
      "userIds",
      emails.map((email) => deterministicUuid("fixture-user", email))
    ),
    userIndexEntries: Object.fromEntries(
      emails.map((email, index) => [email, manifest.userIds[index]])
    ),
    pilotEmailIndexEntries: Object.fromEntries(
      emails.map((email, index) => [email, manifest.pilotIds[index]])
    ),
    roundIds: optionalRoundIds(manifest),
  };
}

function difference(values, retainedValues) {
  const retained = new Set(retainedValues);
  return values.filter((value) => !retained.has(value));
}

async function runJobs(jobs) {
  for (let index = 0; index < jobs.length; index += 50) {
    await Promise.all(jobs.slice(index, index + 50).map((job) => job()));
  }
}

export async function cleanupFixtureOwnership(
  publicContainer,
  privateContainer,
  { ownership, retainedOwnership }
) {
  const removingAllOwnership = retainedOwnership === undefined;
  const retained = retainedOwnership ?? {
    siteIds: [], clubIds: [], teamIds: [], pilotIds: [], userIds: [],
  };
  const stalePilotIds = difference(ownership.pilotIds, retained.pilotIds);
  const staleUserIds = difference(ownership.userIds, retained.userIds);
  const staleClubIds = difference(ownership.clubIds, retained.clubIds);
  const staleTeamIds = difference(ownership.teamIds, retained.teamIds);
  const staleSiteIds = difference(ownership.siteIds, retained.siteIds);
  const {
    privateIndexes,
    publicIndexes,
    seasonIndex,
    seasonPath,
    season,
    seasonRoundIds,
  } = await preflightFixtureStorage(
    publicContainer,
    privateContainer,
    ownership
  );
  await runJobs([
    ...ownership.roundIds.flatMap((id) => [
      () => deleteBlob(privateContainer, `rounds/${id}.json`),
      () => deleteBlob(privateContainer, `round-briefs/${id}.json`),
      () => deleteBlob(privateContainer, `round-briefs/${id}.pdf`),
    ]),
    ...stalePilotIds.map((id) => () => deleteBlob(privateContainer, `pilots/${id}.json`)),
    ...staleUserIds.flatMap((id) => [
      () => deleteBlob(privateContainer, `users/${id}.json`),
      () => deleteBlob(privateContainer, `auth/${id}.json`),
    ]),
    ...staleClubIds.map((id) => () => deleteBlob(privateContainer, `clubs/${id}.json`)),
    ...staleTeamIds.map((id) => () => deleteBlob(privateContainer, `club-teams/${id}.json`)),
    ...staleSiteIds.map((id) => () => deleteBlob(privateContainer, `sites/${id}.json`)),
  ]);

  for (const [path, ids] of [
    ["user-index.json", new Set(ownership.userIds)],
    ["pilot-email-index.json", new Set(ownership.pilotIds)],
  ]) {
    const index = privateIndexes.get(path);
    await writeJson(
      privateContainer,
      path,
      Object.fromEntries(Object.entries(index).filter(([, id]) => !ids.has(id)))
    );
  }

  for (const [path, ids] of [
    ["pilots.json", ownership.pilotIds],
    ["clubs.json", ownership.clubIds],
    ["club-teams.json", ownership.teamIds],
    ["sites.json", ownership.siteIds],
    ["rounds.json", ownership.roundIds],
  ]) {
    const ownedIds = new Set(ids);
    const index = publicIndexes.get(path);
    await writeJson(
      publicContainer,
      path,
      index.filter(({ id }) => !ownedIds.has(id))
    );
  }

  const remainingRoundIds = seasonRoundIds
    .filter((id) => !ownership.roundIds.includes(id));
  if (season) {
    if (removingAllOwnership && remainingRoundIds.length === 0) {
      await deleteBlob(publicContainer, seasonPath);
    } else {
      await writeJson(publicContainer, seasonPath, {
        ...season,
        rounds: remainingRoundIds,
      });
    }
  }
  if (removingAllOwnership && remainingRoundIds.length === 0) {
    await writeJson(
      publicContainer,
      "seasons.json",
      seasonIndex.filter(({ year }) => year !== ownership.seasonYear)
    );
  }
}
