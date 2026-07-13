// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { BlobServiceClient } from "@azure/storage-blob";
import { BCC_API_BASE_URL } from "../lib/loadTestConsts.mjs";
import { loadTestTargetIdentity } from "../lib/loadTestTargetIdentity.mjs";

const CONNECTION_STRING = process.env.FIXTURE_TEST_CONNECTION_STRING ??
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SEED_SCRIPT = join(REPO_ROOT, "scripts/seed-fixtures.mjs");
const WIPE_SCRIPT = join(REPO_ROOT, "scripts/wipe-fixtures.mjs");
const AUDIT_SCRIPT = join(REPO_ROOT, "scripts/audit-fixtures.mjs");

async function writeJson(container, path, value) {
  const body = JSON.stringify(value);
  await container.getBlockBlobClient(path).upload(body, Buffer.byteLength(body));
}

async function readJson(container, path) {
  return JSON.parse((await container.getBlobClient(path).downloadToBuffer()).toString("utf8"));
}

async function environment(t) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const service = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
  const publicContainer = service.getContainerClient(`fixture-tx-public-${suffix}`);
  const privateContainer = service.getContainerClient(`fixture-tx-private-${suffix}`);
  const cwd = await mkdtemp(join(tmpdir(), "bcc-fixture-tx-"));
  await Promise.all([
    publicContainer.createIfNotExists({ access: "blob" }),
    privateContainer.createIfNotExists(),
  ]);
  t.after(async () => {
    await Promise.all([publicContainer.deleteIfExists(), privateContainer.deleteIfExists()]);
    await rm(cwd, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    BLOB_CONNECTION_STRING: CONNECTION_STRING,
    BLOB_CONTAINER_NAME: publicContainer.containerName,
    BLOB_PRIVATE_CONTAINER_NAME: privateContainer.containerName,
  };
  const seedTarget = loadTestTargetIdentity(BCC_API_BASE_URL, env);
  return { cwd, env, publicContainer, privateContainer, seedTarget };
}

function run(script, options) {
  return spawnSync(process.execPath, [script], {
    cwd: options.cwd,
    env: { ...options.env, ...options.extraEnv },
    encoding: "utf8",
    timeout: 120_000,
  });
}

function runAsync(script, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => resolvePromise({ code, signal, stderr }));
  });
}

test("foreign manifest round without persisted seed ownership survives wipe", async (t) => {
  const context = await environment(t);
  assert.equal(run(SEED_SCRIPT, context).status, 0);
  const manifestPath = join(context.cwd, ".fixture-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const foreignRoundId = "00000000-0000-4000-8000-000000000201";
  manifest.roundIds = [foreignRoundId];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await Promise.all([
    writeJson(context.privateContainer, `rounds/${foreignRoundId}.json`, { id: foreignRoundId }),
    writeJson(context.privateContainer, `round-briefs/${foreignRoundId}.json`, { roundId: foreignRoundId }),
    writeJson(context.publicContainer, "rounds.json", [{ id: foreignRoundId }]),
  ]);

  const result = run(WIPE_SCRIPT, context);
  assert.notEqual(result.status, 0);
  assert.equal(await context.privateContainer.getBlobClient(`rounds/${foreignRoundId}.json`).exists(), true);
  assert.equal(await context.privateContainer.getBlobClient(`round-briefs/${foreignRoundId}.json`).exists(), true);
});

for (const phase of [1, 2, 3, 4, 5, 6]) {
  test(`cleanup SIGKILL after phase ${phase} resumes and preserves load metadata`, async (t) => {
    const context = await environment(t);
    assert.equal(run(SEED_SCRIPT, context).status, 0);
    const manifestPath = join(context.cwd, ".fixture-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const roundId = `00000000-0000-4000-8000-00000000020${phase}`;
    manifest.roundIds = [roundId];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(context.cwd, ".loadtest-round-state.json"), JSON.stringify({
      version: 3,
      seedRoundIds: [roundId],
      seedTarget: context.seedTarget,
      loadRoundId: "load-preserved",
      loadTarget: "a".repeat(64),
    }));
    await mkdir(join(context.cwd, "tests/load"), { recursive: true });
    await writeFile(join(context.cwd, "tests/load/.prepared-round.json"), JSON.stringify({ roundId }));
    await Promise.all([
      writeJson(context.privateContainer, `rounds/${roundId}.json`, { id: roundId }),
      writeJson(context.publicContainer, "rounds.json", [{ id: roundId }]),
    ]);

    const interrupted = run(WIPE_SCRIPT, {
      ...context,
      extraEnv: { FIXTURE_CLEANUP_KILL_AFTER_PHASE: String(phase) },
    });
    assert.notEqual(interrupted.status, 0);
    assert.equal(await readFile(join(context.cwd, ".fixture-cleanup-state.json"), "utf8") !== "", true);
    const resumed = run(WIPE_SCRIPT, context);
    assert.equal(resumed.status, 0, resumed.stderr);
    const state = JSON.parse(await readFile(join(context.cwd, ".loadtest-round-state.json"), "utf8"));
    assert.deepEqual(state, {
      version: 3,
      seedRoundIds: [],
      seedTarget: null,
      loadRoundId: "load-preserved",
      loadTarget: "a".repeat(64),
    });
    await assert.rejects(readFile(join(context.cwd, "tests/load/.prepared-round.json")), { code: "ENOENT" });
  });
}

test("two concurrent seeds serialize and publish one complete manifest", async (t) => {
  const context = await environment(t);
  const [first, second] = await Promise.all([
    runAsync(SEED_SCRIPT, context),
    runAsync(SEED_SCRIPT, context),
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  const manifest = JSON.parse(await readFile(join(context.cwd, ".fixture-manifest.json"), "utf8"));
  const pilots = await readJson(context.publicContainer, "pilots.json");
  assert.equal(pilots.length, 500);
  assert.equal(new Set(pilots.map(({ id }) => id)).size, 500);
  assert.equal(manifest.pilotIds.length, 500);
  assert.deepEqual(
    (await readdir(context.cwd)).filter((name) => name.startsWith(".fixture-") && name !== ".fixture-manifest.json" || name.endsWith(".tmp")),
    [],
  );
});

test("machine fixture audit reports exact redacted counts", async (t) => {
  const context = await environment(t);
  assert.equal(run(SEED_SCRIPT, context).status, 0);
  const result = run(AUDIT_SCRIPT, context);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "pass", pilots: 500, clubs: 25, teams: 50, coordinators: 25, pilotOnly: 475,
  });
  assert.equal(result.stdout.includes("@bcc.local"), false);
  assert.equal(result.stdout.includes("password"), false);
});

for (const [label, path, code] of [
  ["public index", "pilots.json", "PUBLIC_INDEX_NULL"],
  ["season blob", "seasons/2026.json", "SEASON_BLOB_NULL"],
]) {
  test(`null ${label} fails before cleanup`, async (t) => {
    const context = await environment(t);
    assert.equal(run(SEED_SCRIPT, context).status, 0);
    await writeJson(context.publicContainer, path, null);
    const result = run(SEED_SCRIPT, context);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`FIXTURE_OWNERSHIP_${code}`));
  });
}

for (const [label, stateField, removed] of [
  ["seed-owned", "seedRoundIds", true],
  ["load-owned", "loadRoundId", false],
]) {
  test(`missing manifest ${label} prepared metadata removal is ${removed}`, async (t) => {
    const context = await environment(t);
    const roundId = `prepared-${label}`;
    await mkdir(join(context.cwd, "tests/load"), { recursive: true });
    await writeFile(join(context.cwd, "tests/load/.prepared-round.json"), JSON.stringify({ roundId }));
    await writeFile(join(context.cwd, ".loadtest-round-state.json"), JSON.stringify({
      version: 3,
      seedRoundIds: stateField === "seedRoundIds" ? [roundId] : [],
      seedTarget: stateField === "seedRoundIds" ? context.seedTarget : null,
      loadRoundId: stateField === "loadRoundId" ? roundId : null,
      loadTarget: stateField === "loadRoundId" ? "a".repeat(64) : null,
    }));
    assert.equal(run(SEED_SCRIPT, context).status, 0);
    const preparedExists = await readFile(join(context.cwd, "tests/load/.prepared-round.json"))
      .then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error));
    assert.equal(preparedExists, !removed);
  });
}
