// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";

import { BlobServiceClient } from "@azure/storage-blob";
import { ActiveWordingPointerSchema, SignToFlyWordingSchema } from "@bccweb/schemas";

import { deterministicUuid } from "../lib/blobSeed.mjs";
import {
  FIXTURE_MANIFEST_PATH,
  SEASON_YEAR,
} from "../lib/loadTestConsts.mjs";

const AZURITE_CONNECTION_STRING = process.env.FIXTURE_TEST_CONNECTION_STRING ??
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SEED_SCRIPT = join(REPO_ROOT, "scripts/seed-fixtures.mjs");
const runId = `${process.pid}-${Date.now()}`;
const publicName = `fixture-public-${runId}`;
const privateName = `fixture-private-${runId}`;
const blobService = BlobServiceClient.fromConnectionString(AZURITE_CONNECTION_STRING);
const publicContainer = blobService.getContainerClient(publicName);
const privateContainer = blobService.getContainerClient(privateName);
let workDir;

function legacyManifest() {
  const siteNames = ["Site Alpha", "Site Bravo", "Site Charlie"];
  const siteIds = siteNames.map((name) => deterministicUuid("fixture-site", name));
  const clubIds = Array.from({ length: 50 }, (_, index) =>
    deterministicUuid("fixture-club", `club${index + 1}`)
  );
  const teamIds = clubIds.flatMap((clubId) =>
    [1, 2].map((teamNumber) =>
      deterministicUuid("fixture-club-team", `${clubId}-${teamNumber}`)
    )
  );
  const emails = Array.from({ length: 500 }, (_, index) =>
    `pilot${String(index + 1).padStart(3, "0")}@bcc.local`
  );
  return {
    seasonYear: SEASON_YEAR,
    siteIds,
    clubIds,
    teamIds,
    pilotIds: emails.map((email) => deterministicUuid("fixture-pilot", email)),
    userIds: emails.map((email) => deterministicUuid("fixture-user", email)),
    roundIds: [],
  };
}

async function writeJson(container, path, value) {
  const body = JSON.stringify(value);
  await container.getBlockBlobClient(path).upload(body, Buffer.byteLength(body));
}

async function readJson(container, path) {
  const response = await container.getBlobClient(path).downloadToBuffer();
  return JSON.parse(response.toString("utf8"));
}

function runScript(script) {
  return spawnSync(process.execPath, [script, "--json"], {
    cwd: workDir,
    encoding: "utf8",
    env: {
      ...process.env,
      BLOB_CONNECTION_STRING: AZURITE_CONNECTION_STRING,
      BLOB_CONTAINER_NAME: publicName,
      BLOB_PRIVATE_CONTAINER_NAME: privateName,
    },
    timeout: 120_000,
  });
}

async function proveRoundOwnership(roundIds) {
  await rm(join(workDir, ".fixture-cleanup-state.json"), { force: true });
  await writeFile(join(workDir, ".loadtest-round-state.json"), JSON.stringify({
    version: 1,
    seedRoundIds: roundIds,
    loadRoundId: "load-preserved",
  }));
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "bcc-fixtures-"));
  await Promise.all([
    publicContainer.createIfNotExists({ access: "blob" }),
    privateContainer.createIfNotExists(),
  ]);
});

after(async () => {
  await Promise.all([
    publicContainer.deleteIfExists(),
    privateContainer.deleteIfExists(),
  ]);
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("seed twice removes stale legacy ownership and preserves nonfixture entries", async () => {
  // Given a complete current seed extended into the exact legacy generation
  const initial = runScript(SEED_SCRIPT);
  assert.equal(initial.status, 0, initial.stderr);
  const staleManifest = legacyManifest();
  const staleClubId = staleManifest.clubIds[49];
  const staleTeamId = staleManifest.teamIds[99];
  const userIndex = await readJson(privateContainer, "user-index.json");
  const publicClubs = await readJson(publicContainer, "clubs.json");
  const publicTeams = await readJson(publicContainer, "club-teams.json");
  await writeFile(
    join(workDir, FIXTURE_MANIFEST_PATH),
    `${JSON.stringify(staleManifest)}\n`
  );
  await Promise.all([
    writeJson(privateContainer, `clubs/${staleClubId}.json`, { id: staleClubId }),
    writeJson(privateContainer, `club-teams/${staleTeamId}.json`, { id: staleTeamId }),
    writeJson(privateContainer, "users/admin-safe.json", { id: "admin-safe" }),
    writeJson(privateContainer, "auth/admin-safe.json", { passwordHash: "REDACTED" }),
    writeJson(privateContainer, "user-index.json", {
      ...userIndex,
      "admin@example.invalid": "admin-safe",
    }),
    writeJson(publicContainer, "clubs.json", [
      ...publicClubs,
      ...staleManifest.clubIds.slice(25).map((id, index) => ({
        id,
        name: `Club ${index + 26}`,
      })),
      { id: "club-safe", name: "Unrelated Club" },
    ]),
    writeJson(publicContainer, "club-teams.json", [
      ...publicTeams,
      ...staleManifest.teamIds.slice(50).map((id, index) => ({
        id,
        clubId: staleManifest.clubIds[Math.floor((index + 50) / 2)],
        clubName: `Club ${Math.floor((index + 50) / 2) + 1}`,
        seasonYear: SEASON_YEAR,
        teamName: `Legacy Team ${index + 51}`,
      })),
    ]),
  ]);

  // When a first seed is interrupted into partial/duplicate state and rerun
  const first = runScript(SEED_SCRIPT);
  assert.equal(first.status, 0, first.stderr);
  const firstManifest = JSON.parse(
    await readFile(join(workDir, FIXTURE_MANIFEST_PATH), "utf8")
  );
  await Promise.all([
    privateContainer.getBlobClient(`users/${firstManifest.userIds[0]}.json`).delete(),
    privateContainer.getBlobClient(`club-teams/${firstManifest.teamIds[0]}.json`).delete(),
  ]);
  const second = runScript(SEED_SCRIPT);

  // Then stale fixture ownership is gone and unrelated records remain
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await privateContainer.getBlobClient(`clubs/${staleClubId}.json`).exists(), false);
  assert.equal(await privateContainer.getBlobClient(`club-teams/${staleTeamId}.json`).exists(), false);
  assert.equal(await privateContainer.getBlobClient("users/admin-safe.json").exists(), true);
  assert.equal(await privateContainer.getBlobClient("auth/admin-safe.json").exists(), true);
  assert.equal((await readJson(privateContainer, "user-index.json"))["admin@example.invalid"], "admin-safe");
  assert.equal((await readJson(publicContainer, "clubs.json")).some(({ id }) => id === "club-safe"), true);
  const manifest = JSON.parse(await readFile(join(workDir, FIXTURE_MANIFEST_PATH), "utf8"));
  assert.equal(await privateContainer.getBlobClient(`users/${manifest.userIds[0]}.json`).exists(), true);
  assert.equal(await privateContainer.getBlobClient(`club-teams/${manifest.teamIds[0]}.json`).exists(), true);
  assert.equal(
    (await readJson(publicContainer, "pilots.json"))
      .filter(({ id }) => id === manifest.pilotIds[0]).length,
    1
  );
  assert.equal(manifest.clubIds.length, 25);
  assert.equal(manifest.teamIds.length, 50);
  assert.equal(new Set(manifest.teamIds).size, 50);
});

test("fresh seed publishes schema-valid private sign wording", async () => {
  // Given / When
  const result = runScript(SEED_SCRIPT);

  // Then
  assert.equal(result.status, 0, result.stderr);
  const wording = SignToFlyWordingSchema.parse(
    await readJson(privateContainer, "sign-to-fly/wording/1.json"),
  );
  const active = ActiveWordingPointerSchema.parse(
    await readJson(privateContainer, "sign-to-fly/wording/active.json"),
  );
  assert.equal(wording.version, 1);
  assert.equal(wording.markdown.includes("@bcc.local"), false);
  assert.deepEqual(active, { activeVersion: 1 });
  assert.equal(await publicContainer.getBlobClient("sign-to-fly/wording/1.json").exists(), false);
});

test("malformed duplicate manifest is rejected before owned blob deletion", async () => {
  // Given a malformed legacy manifest that claims a sentinel round
  const malformed = legacyManifest();
  malformed.teamIds[1] = malformed.teamIds[0];
  const sentinelRoundId = "00000000-0000-4000-8000-000000000001";
  malformed.roundIds = [sentinelRoundId];
  await writeFile(
    join(workDir, FIXTURE_MANIFEST_PATH),
    `${JSON.stringify(malformed)}\n`
  );
  await writeJson(privateContainer, `rounds/${sentinelRoundId}.json`, { id: sentinelRoundId });
  await proveRoundOwnership([sentinelRoundId]);

  // When seeding attempts cleanup, then validation fails before destructive work
  const result = runScript(SEED_SCRIPT);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FIXTURE_OWNERSHIP_TEAMIDS_DUPLICATE/);
  assert.equal(await privateContainer.getBlobClient(`rounds/${sentinelRoundId}.json`).exists(), true);
});

test("foreign-season manifest is rejected before owned blob deletion", async () => {
  // Given an otherwise valid legacy manifest for a non-fixture season
  const foreignSeason = legacyManifest();
  const sentinelRoundId = "00000000-0000-4000-8000-000000000002";
  foreignSeason.seasonYear = SEASON_YEAR - 1;
  foreignSeason.roundIds = [sentinelRoundId];
  await writeFile(
    join(workDir, FIXTURE_MANIFEST_PATH),
    `${JSON.stringify(foreignSeason)}\n`
  );
  await writeJson(privateContainer, `rounds/${sentinelRoundId}.json`, { id: sentinelRoundId });
  await proveRoundOwnership([sentinelRoundId]);

  // When seeding attempts cleanup, then season validation fails before deletion
  const result = runScript(SEED_SCRIPT);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FIXTURE_OWNERSHIP_SEASON_YEAR/);
  assert.equal(await privateContainer.getBlobClient(`rounds/${sentinelRoundId}.json`).exists(), true);
});

test("malformed public index entry is rejected before owned blob deletion", async () => {
  // Given valid ownership, a malformed stored index, and an owned sentinel round
  const manifest = JSON.parse(await readFile(join(workDir, FIXTURE_MANIFEST_PATH), "utf8"));
  const sentinelRoundId = "00000000-0000-4000-8000-000000000003";
  manifest.seasonYear = SEASON_YEAR;
  manifest.roundIds = [sentinelRoundId];
  await writeFile(join(workDir, FIXTURE_MANIFEST_PATH), `${JSON.stringify(manifest)}\n`);
  await writeJson(publicContainer, "pilots.json", [null]);
  await writeJson(privateContainer, `rounds/${sentinelRoundId}.json`, { id: sentinelRoundId });
  await proveRoundOwnership([sentinelRoundId]);

  // When seeding attempts cleanup, then index validation fails before deletion
  const result = runScript(SEED_SCRIPT);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FIXTURE_OWNERSHIP_PUBLIC_INDEX_ENTRY/);
  assert.equal(await privateContainer.getBlobClient(`rounds/${sentinelRoundId}.json`).exists(), true);
});

test("malformed season index is rejected before owned blob deletion", async () => {
  // Given valid ownership, a malformed season summary, and an owned sentinel round
  const manifest = legacyManifest();
  const sentinelRoundId = "00000000-0000-4000-8000-000000000004";
  manifest.roundIds = [sentinelRoundId];
  await writeFile(join(workDir, FIXTURE_MANIFEST_PATH), `${JSON.stringify(manifest)}\n`);
  await writeJson(publicContainer, "pilots.json", []);
  await writeJson(publicContainer, "seasons.json", [null]);
  await writeJson(privateContainer, `rounds/${sentinelRoundId}.json`, { id: sentinelRoundId });
  await proveRoundOwnership([sentinelRoundId]);

  // When seeding attempts cleanup, then season preflight fails before deletion
  const result = runScript(SEED_SCRIPT);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FIXTURE_OWNERSHIP_SEASON_INDEX_ENTRY/);
  assert.equal(await privateContainer.getBlobClient(`rounds/${sentinelRoundId}.json`).exists(), true);
});

test("malformed season blob is rejected before owned blob deletion", async () => {
  // Given valid ownership, malformed season rounds, and an owned sentinel round
  const manifest = legacyManifest();
  const sentinelRoundId = "00000000-0000-4000-8000-000000000005";
  manifest.roundIds = [sentinelRoundId];
  await writeFile(join(workDir, FIXTURE_MANIFEST_PATH), `${JSON.stringify(manifest)}\n`);
  await writeJson(publicContainer, "seasons.json", []);
  await writeJson(publicContainer, `seasons/${SEASON_YEAR}.json`, { rounds: null });
  await writeJson(privateContainer, `rounds/${sentinelRoundId}.json`, { id: sentinelRoundId });
  await proveRoundOwnership([sentinelRoundId]);

  // When seeding attempts cleanup, then season preflight fails before deletion
  const result = runScript(SEED_SCRIPT);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FIXTURE_OWNERSHIP_SEASON_BLOB_ROUNDS/);
  assert.equal(await privateContainer.getBlobClient(`rounds/${sentinelRoundId}.json`).exists(), true);
});
