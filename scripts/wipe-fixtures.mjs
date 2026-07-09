#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * wipe-fixtures.mjs
 *
 * Surgical, manifest-driven wipe for load-test fixtures.
 *
 * Safety rules:
 * - The manifest is authoritative; never scan blob prefixes.
 * - Missing blobs are fine; deleteBlob() is delete-if-exists.
 * - The admin user is preserved by omission: do not place admin IDs in the manifest.
 *
 * Season handling follows the T10 plan spec: filter `seasons.json`, then delete
 * or filter `seasons/{seasonYear}.json` depending on whether non-fixture rounds
 * remain.
 */

import {
  getPrivateContainer,
  getPublicContainer,
  readJson,
  writeJson,
  deleteBlob,
} from "./lib/blobSeed.mjs";
import { FIXTURE_MANIFEST_PATH, PREPARED_ROUND_PATH } from "./lib/loadTestConsts.mjs";
import { readFileSync, existsSync, unlinkSync } from "node:fs";

const privateContainer = getPrivateContainer();
const publicContainer = getPublicContainer();

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function runChunked(tasks, size = 50) {
  for (const group of chunk(tasks, size)) {
    await Promise.all(group.map((task) => task()));
  }
}

function asIdSet(values) {
  return new Set(Array.isArray(values) ? values : []);
}

async function main() {
  if (!existsSync(FIXTURE_MANIFEST_PATH)) {
    console.error("[wipe-fixtures] no manifest; nothing to wipe");
    process.exit(0);
  }

  const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST_PATH, "utf8"));
  const seasonYear = manifest.seasonYear;

  const roundIds = Array.isArray(manifest.roundIds) ? manifest.roundIds : [];
  const pilotIds = Array.isArray(manifest.pilotIds) ? manifest.pilotIds : [];
  const userIds = Array.isArray(manifest.userIds) ? manifest.userIds : [];
  const clubIds = Array.isArray(manifest.clubIds) ? manifest.clubIds : [];
  const teamIds = Array.isArray(manifest.teamIds) ? manifest.teamIds : [];
  const siteIds = Array.isArray(manifest.siteIds) ? manifest.siteIds : [];

  const roundSet = asIdSet(roundIds);
  const pilotSet = asIdSet(pilotIds);
  const userSet = asIdSet(userIds);
  const clubSet = asIdSet(clubIds);
  const teamSet = asIdSet(teamIds);
  await runChunked(
    [
      ...roundIds.flatMap((id) => [
        () => deleteBlob(privateContainer, `rounds/${id}.json`),
        () => deleteBlob(privateContainer, `round-briefs/${id}.json`),
        () => deleteBlob(privateContainer, `round-briefs/${id}.pdf`),
      ]),
      ...pilotIds.map((id) => () => deleteBlob(privateContainer, `pilots/${id}.json`)),
      ...userIds.flatMap((id) => [
        () => deleteBlob(privateContainer, `users/${id}.json`),
        () => deleteBlob(privateContainer, `auth/${id}.json`),
      ]),
      ...clubIds.map((id) => () => deleteBlob(privateContainer, `clubs/${id}.json`)),
      ...teamIds.map((id) => () => deleteBlob(privateContainer, `club-teams/${id}.json`)),
      ...siteIds.map((id) => () => deleteBlob(privateContainer, `sites/${id}.json`)),
    ],
    50,
  );

  const userIndex = (await readJson(privateContainer, "user-index.json")) ?? {};
  const nextUserIndex = Object.fromEntries(
    Object.entries(userIndex).filter(([, value]) => !userSet.has(value)),
  );
  await writeJson(privateContainer, "user-index.json", nextUserIndex);

  const pilotEmailIndex = (await readJson(privateContainer, "pilot-email-index.json")) ?? {};
  const nextPilotEmailIndex = Object.fromEntries(
    Object.entries(pilotEmailIndex).filter(([, value]) => !pilotSet.has(value)),
  );
  await writeJson(privateContainer, "pilot-email-index.json", nextPilotEmailIndex);

  const publicIndexTasks = [];

  const publicIndexSpecs = [
    ["pilots.json", pilotSet],
    ["clubs.json", clubSet],
    ["club-teams.json", teamSet],
    ["rounds.json", roundSet],
  ];

  for (const [path, idSet] of publicIndexSpecs) {
    publicIndexTasks.push(async () => {
      const index = (await readJson(publicContainer, path)) ?? [];
      const next = Array.isArray(index)
        ? index.filter((entry) => !idSet.has(entry?.id))
        : [];
      await writeJson(publicContainer, path, next);
    });
  }

  await runChunked(publicIndexTasks, 50);

  if (seasonYear != null) {
    // Plan T10 spec: read public `seasons.json`, filter out the fixture season,
    // then write it back instead of leaving stale fixture summary entries behind.
    const seasonsIndex = (await readJson(publicContainer, "seasons.json")) ?? [];
    const nextSeasonsIndex = Array.isArray(seasonsIndex)
      ? seasonsIndex.filter((season) => season?.year !== seasonYear)
      : [];
    await writeJson(publicContainer, "seasons.json", nextSeasonsIndex);

    // Plan T10 spec: delete `seasons/{seasonYear}.json` only when it is entirely
    // fixture-seeded; otherwise remove just the manifest round IDs from `rounds`.
    const seasonPath = `seasons/${seasonYear}.json`;
    const season = await readJson(publicContainer, seasonPath);
    if (season != null) {
      const rounds = Array.isArray(season.rounds) ? season.rounds : [];
      const containsOnlyFixtureRounds = rounds.every((id) => roundSet.has(id));
      if (containsOnlyFixtureRounds) {
        await deleteBlob(publicContainer, seasonPath);
      } else {
        await writeJson(publicContainer, seasonPath, {
          ...season,
          rounds: rounds.filter((id) => !roundSet.has(id)),
        });
      }
    }
  }

  if (existsSync(FIXTURE_MANIFEST_PATH)) unlinkSync(FIXTURE_MANIFEST_PATH);
  if (existsSync(PREPARED_ROUND_PATH)) unlinkSync(PREPARED_ROUND_PATH);

  console.error(
    `[wipe-fixtures] OK: ${pilotIds.length} pilots / ${clubIds.length} clubs / ${teamIds.length} teams / ${roundIds.length} rounds / ${siteIds.length} sites removed`,
  );
}

main().catch((err) => {
  console.error(`[wipe-fixtures] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
