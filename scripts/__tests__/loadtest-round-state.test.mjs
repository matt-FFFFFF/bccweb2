// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendSeedRoundId,
  LoadTestRoundStateError,
  parseLoadTestRoundState,
  readLoadTestRoundState,
  replaceSeedRoundIds,
  setLoadRoundId,
  writeJsonAtomically,
  assertLoadRoundTarget,
  assertSeedRoundTarget,
} from "../lib/loadTestRoundState.mjs";
import { loadTestTargetIdentity } from "../lib/loadTestTargetIdentity.mjs";

const TARGET = "a".repeat(64);

async function statePath(t) {
  const directory = await mkdtemp(join(tmpdir(), "bcc-round-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, ".loadtest-round-state.json");
}

test("missing state reads as empty current state", async (t) => {
  // Given
  const path = await statePath(t);

  // When
  const state = await readLoadTestRoundState({ path });

  // Then
  assert.deepEqual(state, {
    version: 3,
    seedRoundIds: [],
    seedTarget: null,
    loadRoundId: null,
    loadTarget: null,
  });
});

test("state parser rejects malformed and unexpected values", () => {
  // Given
  const malformed = [
    null,
    { version: 3, seedRoundIds: [], loadRoundId: null, loadTarget: null },
    { version: 2, seedRoundIds: ["same", "same"], loadRoundId: null, loadTarget: null },
    { version: 2, seedRoundIds: [], loadRoundId: null, loadTarget: null, extra: true },
    { version: 2, seedRoundIds: [], loadRoundId: "round", loadTarget: null },
    { version: 1, seedRoundIds: [], loadRoundId: "legacy-owned" },
  ];

  // When / Then
  for (const value of malformed) {
    assert.throws(() => parseLoadTestRoundState(value), LoadTestRoundStateError);
  }
});

test("seed and load updates preserve the namespace they do not own", async (t) => {
  // Given
  const path = await statePath(t);
  await writeFile(path, JSON.stringify({
    version: 3,
    seedRoundIds: ["seed-old"],
    seedTarget: TARGET,
    loadRoundId: "load-owned",
    loadTarget: TARGET,
  }));

  // When
  await replaceSeedRoundIds([], TARGET, { path });
  await appendSeedRoundId("seed-new", TARGET, { path });
  await setLoadRoundId(null, undefined, { path });

  // Then
  assert.deepEqual(await readLoadTestRoundState({ path }), {
    version: 3,
    seedRoundIds: ["seed-new"],
    seedTarget: TARGET,
    loadRoundId: null,
    loadTarget: null,
  });
});

test("atomic state writes use mode 0600", async (t) => {
  // Given
  const path = await statePath(t);

  // When
  await setLoadRoundId("load-round", TARGET, { path });

  // Then
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("atomic writer removes its same-directory temp after rename failure", async (t) => {
  // Given
  const path = await statePath(t);
  let tempPath;
  let removedPath;
  const files = {
    writeFile: async (candidate) => { tempPath = candidate; },
    chmod: async () => {},
    rename: async () => { throw new Error("injected rename failure"); },
    unlink: async (candidate) => { removedPath = candidate; },
  };

  // When / Then
  await assert.rejects(
    writeJsonAtomically(path, { version: 2 }, { files }),
    /injected rename failure/,
  );
  assert.equal(removedPath, tempPath);
  assert.equal(new URL(`file://${tempPath}`).pathname.startsWith(new URL(`file://${join(path, "..")}`).pathname), true);
});

test("invalid JSON state fails without being replaced", async (t) => {
  // Given
  const path = await statePath(t);
  await writeFile(path, "not-json");

  // When / Then
  await assert.rejects(setLoadRoundId("round", TARGET, { path }), LoadTestRoundStateError);
  assert.equal(await readFile(path, "utf8"), "not-json");
});

test("concurrent seed and load updates preserve both ownership namespaces", async (t) => {
  // Given
  const path = await statePath(t);

  // When
  await Promise.all([
    appendSeedRoundId("seed-concurrent", TARGET, { path }),
    setLoadRoundId("load-concurrent", TARGET, { path }),
  ]);

  // Then
  assert.deepEqual(await readLoadTestRoundState({ path }), {
    version: 3,
    seedRoundIds: ["seed-concurrent"],
    seedTarget: TARGET,
    loadRoundId: "load-concurrent",
    loadTarget: TARGET,
  });
});

test("owned load state rejects a different target before mutation", () => {
  // Given
  const state = { version: 2, seedRoundIds: [], loadRoundId: "owned", loadTarget: TARGET };

  // When / Then
  assert.throws(() => assertLoadRoundTarget(state, "b".repeat(64)), /different target stack/);
  assert.doesNotThrow(() => assertLoadRoundTarget(state, TARGET));
});

test("target identity is deterministic, non-secret, and stack-specific", () => {
  // Given
  const firstEnvironment = {
    BLOB_CONNECTION_STRING: "AccountName=storage-a;AccountKey=secret-a;BlobEndpoint=https://storage-a.invalid/blob;",
    AzureWebJobsStorage: "AccountName=storage-a;AccountKey=queue-secret;QueueEndpoint=https://storage-a.invalid/queue;",
  };

  // When
  const first = loadTestTargetIdentity("https://api.loadtest.invalid/path", firstEnvironment);
  const repeated = loadTestTargetIdentity("https://api.loadtest.invalid/other", firstEnvironment);
  const second = loadTestTargetIdentity("https://api.loadtest.invalid", {
    ...firstEnvironment,
    BLOB_CONNECTION_STRING: "AccountName=storage-b;AccountKey=secret-b;BlobEndpoint=https://storage-b.invalid/blob;",
  });

  // Then
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /storage|secret|api/u);
});

test("target identity changes with either effective blob container", () => {
  // Given
  const environment = {
    BLOB_CONNECTION_STRING: "AccountName=storage-a;AccountKey=secret-a;BlobEndpoint=https://storage-a.invalid/blob;",
    AzureWebJobsStorage: "AccountName=storage-a;AccountKey=queue-secret;QueueEndpoint=https://storage-a.invalid/queue;",
    BLOB_CONTAINER_NAME: "public-a",
    BLOB_PRIVATE_CONTAINER_NAME: "private-a",
  };

  // When
  const baseline = loadTestTargetIdentity("https://api.loadtest.invalid", environment);
  const publicChanged = loadTestTargetIdentity("https://api.loadtest.invalid", {
    ...environment,
    BLOB_CONTAINER_NAME: "public-b",
  });
  const privateChanged = loadTestTargetIdentity("https://api.loadtest.invalid", {
    ...environment,
    BLOB_PRIVATE_CONTAINER_NAME: "private-b",
  });

  // Then
  assert.notEqual(baseline, publicChanged);
  assert.notEqual(baseline, privateChanged);
});

test("owned seed state rejects a different target before mutation", () => {
  // Given
  const state = {
    version: 3,
    seedRoundIds: ["seed-owned"],
    seedTarget: TARGET,
    loadRoundId: null,
    loadTarget: null,
  };

  // When / Then
  assert.throws(() => assertSeedRoundTarget(state, "b".repeat(64)), /different target stack/);
  assert.doesNotThrow(() => assertSeedRoundTarget(state, TARGET));
});

test("seed updates reject a different target without rewriting ownership", async (t) => {
  // Given
  const path = await statePath(t);
  const state = {
    version: 3,
    seedRoundIds: ["seed-owned"],
    seedTarget: TARGET,
    loadRoundId: null,
    loadTarget: null,
  };
  await writeFile(path, `${JSON.stringify(state)}\n`);

  // When / Then
  await assert.rejects(
    replaceSeedRoundIds([], "b".repeat(64), { path }),
    /different target stack/,
  );
  assert.deepEqual(await readLoadTestRoundState({ path }), state);
});
