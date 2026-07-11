// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { BlobServiceClient } from "@azure/storage-blob";

import { deterministicUuid } from "../lib/blobSeed.mjs";
import { FIXTURE_MANIFEST_PATH, SEASON_YEAR } from "../lib/loadTestConsts.mjs";

const CONNECTION_STRING = process.env.FIXTURE_TEST_CONNECTION_STRING ??
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SEED_SCRIPT = join(REPO_ROOT, "scripts/seed-fixtures.mjs");
const WIPE_SCRIPT = join(REPO_ROOT, "scripts/wipe-fixtures.mjs");
const AUDIT_SCRIPT = join(REPO_ROOT, "scripts/audit-fixtures.mjs");

function legacyManifest() {
  const clubIds = Array.from({ length: 50 }, (_, index) =>
    deterministicUuid("fixture-club", `club${index + 1}`)
  );
  const emails = Array.from({ length: 500 }, (_, index) =>
    `pilot${String(index + 1).padStart(3, "0")}@bcc.local`
  );
  return {
    seasonYear: SEASON_YEAR,
    siteIds: ["Site Alpha", "Site Bravo", "Site Charlie"]
      .map((name) => deterministicUuid("fixture-site", name)),
    clubIds,
    teamIds: clubIds.flatMap((clubId) => [1, 2].map((teamNumber) =>
      deterministicUuid("fixture-club-team", `${clubId}-${teamNumber}`)
    )),
    pilotIds: emails.map((email) => deterministicUuid("fixture-pilot", email)),
    userIds: emails.map((email) => deterministicUuid("fixture-user", email)),
    roundIds: ["00000000-0000-4000-8000-000000000101"],
  };
}

async function writeJson(container, path, value) {
  const body = JSON.stringify(value);
  await container.getBlockBlobClient(path).upload(body, Buffer.byteLength(body));
}

async function readJson(container, path) {
  return JSON.parse((await container.getBlobClient(path).downloadToBuffer()).toString("utf8"));
}

async function withEnvironment(run) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const publicName = `fixture-adv-public-${suffix}`;
  const privateName = `fixture-adv-private-${suffix}`;
  const service = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
  const publicContainer = service.getContainerClient(publicName);
  const privateContainer = service.getContainerClient(privateName);
  const workDir = await mkdtemp(join(tmpdir(), "bcc-fixture-adv-"));
  await Promise.all([
    publicContainer.createIfNotExists({ access: "blob" }),
    privateContainer.createIfNotExists(),
  ]);
  const runScript = (script) => spawnSync(process.execPath, [script, "--json"], {
    cwd: workDir,
    encoding: "utf8",
    env: {
      ...process.env,
      BLOB_CONNECTION_STRING: CONNECTION_STRING,
      BLOB_CONTAINER_NAME: publicName,
      BLOB_PRIVATE_CONTAINER_NAME: privateName,
    },
    timeout: 120_000,
  });
  try {
    await run({ publicContainer, privateContainer, workDir, runScript });
  } finally {
    await Promise.all([publicContainer.deleteIfExists(), privateContainer.deleteIfExists()]);
    await rm(workDir, { recursive: true, force: true });
  }
}

async function seedCompleteLegacyState(environment, mutate) {
  const manifest = legacyManifest();
  const emails = Array.from({ length: 500 }, (_, index) =>
    `pilot${String(index + 1).padStart(3, "0")}@bcc.local`
  );
  const userIndex = Object.fromEntries(emails.map((email, index) => [email, manifest.userIds[index]]));
  const pilotIndex = Object.fromEntries(emails.map((email, index) => [email, manifest.pilotIds[index]]));
  const publicIndexes = {
    "pilots.json": manifest.pilotIds.map((id, index) => ({ id, name: `Pilot ${index + 1}` })),
    "clubs.json": manifest.clubIds.map((id, index) => ({ id, name: `Club ${index + 1}` })),
    "club-teams.json": manifest.teamIds.map((id, index) => ({
      id,
      clubId: manifest.clubIds[Math.floor(index / 2)],
      clubName: `Club ${Math.floor(index / 2) + 1}`,
      seasonYear: SEASON_YEAR,
      teamName: `Team ${index + 1}`,
    })),
    "sites.json": manifest.siteIds.map((id, index) => ({ id, name: `Site ${index + 1}` })),
    "rounds.json": [{ id: manifest.roundIds[0] }],
  };
  mutate({ manifest, userIndex, pilotIndex, publicIndexes });
  await writeFile(join(environment.workDir, FIXTURE_MANIFEST_PATH), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(environment.workDir, ".loadtest-round-state.json"), JSON.stringify({
    version: 1,
    seedRoundIds: manifest.roundIds,
    loadRoundId: "load-preserved",
  }));
  await Promise.all([
    writeJson(environment.privateContainer, "user-index.json", userIndex),
    writeJson(environment.privateContainer, "pilot-email-index.json", pilotIndex),
    writeJson(environment.privateContainer, `rounds/${manifest.roundIds[0]}.json`, { id: manifest.roundIds[0] }),
    ...Object.entries(publicIndexes).map(([path, value]) =>
      writeJson(environment.publicContainer, path, value)
    ),
  ]);
  return manifest;
}

test("partial valid fixture index fails before destructive cleanup", async () => {
  await withEnvironment(async (environment) => {
    const manifest = await seedCompleteLegacyState(environment, ({ userIndex }) => {
      delete userIndex["pilot001@bcc.local"];
    });
    const result = environment.runScript(WIPE_SCRIPT);
    assert.notEqual(result.status, 0);
    assert.equal(
      await environment.privateContainer.getBlobClient(`rounds/${manifest.roundIds[0]}.json`).exists(),
      true
    );
  });
});

test("partial public fixture index fails before destructive cleanup", async () => {
  await withEnvironment(async (environment) => {
    const manifest = await seedCompleteLegacyState(environment, ({ publicIndexes }) => {
      publicIndexes["pilots.json"].shift();
    });
    const result = environment.runScript(WIPE_SCRIPT);
    assert.notEqual(result.status, 0);
    assert.equal(
      await environment.privateContainer.getBlobClient(`rounds/${manifest.roundIds[0]}.json`).exists(),
      true
    );
  });
});

test("duplicate fixture index entry fails before destructive cleanup", async () => {
  await withEnvironment(async (environment) => {
    const manifest = await seedCompleteLegacyState(environment, ({ publicIndexes }) => {
      publicIndexes["pilots.json"].push(publicIndexes["pilots.json"][0]);
    });
    const result = environment.runScript(WIPE_SCRIPT);
    assert.notEqual(result.status, 0);
    assert.equal(
      await environment.privateContainer.getBlobClient(`rounds/${manifest.roundIds[0]}.json`).exists(),
      true
    );
  });
});

test("swapped private fixture mappings fail before destructive cleanup", async () => {
  await withEnvironment(async (environment) => {
    const manifest = await seedCompleteLegacyState(environment, ({ userIndex }) => {
      const first = userIndex["pilot001@bcc.local"];
      userIndex["pilot001@bcc.local"] = userIndex["pilot002@bcc.local"];
      userIndex["pilot002@bcc.local"] = first;
    });
    const result = environment.runScript(WIPE_SCRIPT);
    assert.notEqual(result.status, 0);
    assert.equal(
      await environment.privateContainer.getBlobClient(`rounds/${manifest.roundIds[0]}.json`).exists(),
      true
    );
  });
});

test("missing manifest after storage writes converges on repeated rerun", async () => {
  await withEnvironment(async (environment) => {
    assert.equal(environment.runScript(SEED_SCRIPT).status, 0);
    const firstManifest = JSON.parse(
      await readFile(join(environment.workDir, FIXTURE_MANIFEST_PATH), "utf8")
    );
    await unlink(join(environment.workDir, FIXTURE_MANIFEST_PATH));
    const userIndex = await readJson(environment.privateContainer, "user-index.json");
    delete userIndex["pilot001@bcc.local"];
    await Promise.all([
      environment.privateContainer.getBlobClient(`users/${firstManifest.userIds[0]}.json`).delete(),
      environment.privateContainer.getBlobClient(`club-teams/${firstManifest.teamIds[0]}.json`).delete(),
      writeJson(environment.privateContainer, "user-index.json", userIndex),
    ]);
    assert.equal(environment.runScript(SEED_SCRIPT).status, 0);
    await unlink(join(environment.workDir, FIXTURE_MANIFEST_PATH));
    const [publicPilots, publicTeams] = await Promise.all([
      readJson(environment.publicContainer, "pilots.json"),
      readJson(environment.publicContainer, "club-teams.json"),
    ]);
    await Promise.all([
      writeJson(environment.publicContainer, "pilots.json", [publicPilots[0], ...publicPilots]),
      writeJson(environment.publicContainer, "club-teams.json", [publicTeams[0], ...publicTeams]),
    ]);
    assert.equal(environment.runScript(SEED_SCRIPT).status, 0);

    const manifest = JSON.parse(await readFile(join(environment.workDir, FIXTURE_MANIFEST_PATH), "utf8"));
    for (const [path, ids] of [
      ["pilots.json", manifest.pilotIds],
      ["clubs.json", manifest.clubIds],
      ["club-teams.json", manifest.teamIds],
      ["sites.json", manifest.siteIds],
    ]) {
      const owned = new Set(ids);
      const rows = (await readJson(environment.publicContainer, path))
        .filter(({ id }) => owned.has(id));
      assert.equal(rows.length, owned.size);
      assert.equal(new Set(rows.map(({ id }) => id)).size, owned.size);
    }
    assert.equal(environment.runScript(AUDIT_SCRIPT).status, 0);
  });
});

test("missing manifest removes deterministic legacy remainder without touching sentinels", async () => {
  await withEnvironment(async (environment) => {
    const legacy = legacyManifest();
    const staleClubId = legacy.clubIds[49];
    const staleTeamId = legacy.teamIds[99];
    await Promise.all([
      writeJson(environment.privateContainer, `clubs/${staleClubId}.json`, { id: staleClubId }),
      writeJson(environment.privateContainer, `club-teams/${staleTeamId}.json`, { id: staleTeamId }),
      writeJson(environment.privateContainer, "clubs/foreign.json", { id: "foreign" }),
      writeJson(environment.publicContainer, "clubs.json", [
        { id: staleClubId, name: "Legacy Club" },
        { id: "foreign", name: "Foreign Club" },
      ]),
      writeJson(environment.publicContainer, "club-teams.json", [{
        id: staleTeamId,
        clubId: staleClubId,
        clubName: "Legacy Club",
        seasonYear: SEASON_YEAR,
        teamName: "Legacy Team",
      }]),
    ]);
    assert.equal(environment.runScript(SEED_SCRIPT).status, 0);
    assert.equal(await environment.privateContainer.getBlobClient(`clubs/${staleClubId}.json`).exists(), false);
    assert.equal(await environment.privateContainer.getBlobClient(`club-teams/${staleTeamId}.json`).exists(), false);
    assert.equal(await environment.privateContainer.getBlobClient("clubs/foreign.json").exists(), true);
    assert.equal(
      (await readJson(environment.publicContainer, "clubs.json")).some(({ id }) => id === "foreign"),
      true
    );
  });
});
