// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { readJson } from "./blobSeed.mjs";

function fail(code, detail) {
  throw new Error(`FIXTURE_OWNERSHIP_${code}: ${detail}`);
}

async function readOptionalJson(container, path, code) {
  const value = await readJson(container, path);
  if (value !== null) return value;
  if (await container.getBlobClient(path).exists()) {
    fail(code, `${path} must not contain JSON null`);
  }
  return null;
}

function isPublicIndexEntry(path, entry) {
  if (typeof entry !== "object" || entry === null || typeof entry.id !== "string") {
    return false;
  }
  if (["pilots.json", "clubs.json", "sites.json"].includes(path)) {
    return typeof entry.name === "string";
  }
  if (path === "club-teams.json") {
    return (
      typeof entry.clubId === "string" &&
      typeof entry.clubName === "string" &&
      Number.isInteger(entry.seasonYear) &&
      typeof entry.teamName === "string"
    );
  }
  return true;
}

function requireUniqueIds(entries, path) {
  const ids = entries.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    fail("INDEX_DUPLICATE", `${path} contains duplicate ids`);
  }
}

function requireExactOwnedMembership(entries, expectedIds, path) {
  const actualIds = new Set(entries.map(({ id }) => id));
  const missingId = expectedIds.find((id) => !actualIds.has(id));
  if (missingId) {
    fail("INDEX_PARTIAL", `${path} is missing fixture ownership`);
  }
}

function requireExactOwnedValues(index, expectedEntries, path) {
  const values = Object.values(index);
  if (new Set(values).size !== values.length) {
    fail("INDEX_DUPLICATE", `${path} contains duplicate ids`);
  }
  for (const [key, expectedId] of Object.entries(expectedEntries)) {
    if (index[key] !== expectedId) {
      fail("INDEX_PARTIAL", `${path} has incomplete fixture ownership`);
    }
  }
}

export async function preflightFixtureStorage(
  publicContainer,
  privateContainer,
  ownership
) {
  const privateIndexes = new Map();
  for (const path of ["user-index.json", "pilot-email-index.json"]) {
    const index = await readOptionalJson(privateContainer, path, "PRIVATE_INDEX_NULL");
    if (index !== null && (typeof index !== "object" || Array.isArray(index))) {
      fail("PRIVATE_INDEX_TYPE", `${path} must contain an object`);
    }
    const parsedIndex = index ?? {};
    if (Object.values(parsedIndex).some((id) => typeof id !== "string")) {
      fail("PRIVATE_INDEX_ENTRY", `${path} values must be string ids`);
    }
    privateIndexes.set(path, parsedIndex);
  }

  const publicIndexes = new Map();
  for (const path of [
    "pilots.json", "clubs.json", "club-teams.json", "sites.json", "rounds.json",
  ]) {
    const index = await readOptionalJson(publicContainer, path, "PUBLIC_INDEX_NULL");
    if (index !== null && !Array.isArray(index)) {
      fail("PUBLIC_INDEX_TYPE", `${path} must contain an array`);
    }
    const parsedIndex = index ?? [];
    if (parsedIndex.some((entry) => !isPublicIndexEntry(path, entry))) {
      fail("PUBLIC_INDEX_ENTRY", `${path} contains an invalid entry`);
    }
    requireUniqueIds(parsedIndex, path);
    publicIndexes.set(path, parsedIndex);
  }

  const seasons = await readOptionalJson(publicContainer, "seasons.json", "SEASON_INDEX_NULL");
  if (seasons !== null && !Array.isArray(seasons)) {
    fail("SEASON_INDEX_TYPE", "seasons.json must contain an array");
  }
  const seasonIndex = seasons ?? [];
  if (seasonIndex.some((entry) =>
    typeof entry !== "object" || entry === null ||
    typeof entry.id !== "string" || !Number.isInteger(entry.year) ||
    typeof entry.active !== "boolean"
  )) {
    fail("SEASON_INDEX_ENTRY", "seasons.json contains an invalid summary");
  }

  const seasonPath = `seasons/${ownership.seasonYear}.json`;
  const season = await readOptionalJson(publicContainer, seasonPath, "SEASON_BLOB_NULL");
  if (season !== null && (typeof season !== "object" || Array.isArray(season))) {
    fail("SEASON_BLOB_TYPE", `${seasonPath} must contain an object`);
  }
  if (season?.rounds !== undefined && !Array.isArray(season.rounds)) {
    fail("SEASON_BLOB_ROUNDS", `${seasonPath} rounds must be an array`);
  }
  const seasonRoundIds = season?.rounds ?? [];
  if (seasonRoundIds.some((id) => typeof id !== "string")) {
    fail("SEASON_BLOB_ROUNDS", `${seasonPath} rounds must contain string ids`);
  }
  if (season?.leagueTable !== undefined && !Array.isArray(season.leagueTable)) {
    fail("SEASON_BLOB_LEAGUE", `${seasonPath} leagueTable must be an array`);
  }

  requireExactOwnedValues(
    privateIndexes.get("user-index.json"),
    ownership.userIndexEntries,
    "user-index.json"
  );
  requireExactOwnedValues(
    privateIndexes.get("pilot-email-index.json"),
    ownership.pilotEmailIndexEntries,
    "pilot-email-index.json"
  );
  for (const [path, expectedIds] of [
    ["pilots.json", ownership.pilotIds],
    ["clubs.json", ownership.clubIds],
    ["club-teams.json", ownership.teamIds],
    ["sites.json", ownership.siteIds],
    ["rounds.json", ownership.roundIds],
  ]) {
    requireExactOwnedMembership(publicIndexes.get(path), expectedIds, path);
  }

  return {
    privateIndexes,
    publicIndexes,
    seasonIndex,
    seasonPath,
    season,
    seasonRoundIds,
  };
}
