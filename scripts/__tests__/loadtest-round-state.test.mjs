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
} from "../lib/loadTestRoundState.mjs";

async function statePath(t) {
  const directory = await mkdtemp(join(tmpdir(), "bcc-round-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, ".loadtest-round-state.json");
}

test("missing state reads as empty version one state", async (t) => {
  // Given
  const path = await statePath(t);

  // When
  const state = await readLoadTestRoundState({ path });

  // Then
  assert.deepEqual(state, { version: 1, seedRoundIds: [], loadRoundId: null });
});

test("state parser rejects malformed and unexpected values", () => {
  // Given
  const malformed = [
    null,
    { version: 2, seedRoundIds: [], loadRoundId: null },
    { version: 1, seedRoundIds: ["same", "same"], loadRoundId: null },
    { version: 1, seedRoundIds: [], loadRoundId: null, extra: true },
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
    version: 1,
    seedRoundIds: ["seed-old"],
    loadRoundId: "load-owned",
  }));

  // When
  await replaceSeedRoundIds([], { path });
  await appendSeedRoundId("seed-new", { path });
  await setLoadRoundId(null, { path });

  // Then
  assert.deepEqual(await readLoadTestRoundState({ path }), {
    version: 1,
    seedRoundIds: ["seed-new"],
    loadRoundId: null,
  });
});

test("atomic state writes use mode 0600", async (t) => {
  // Given
  const path = await statePath(t);

  // When
  await setLoadRoundId("load-round", { path });

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
    writeJsonAtomically(path, { version: 1 }, { files }),
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
  await assert.rejects(setLoadRoundId("round", { path }), LoadTestRoundStateError);
  assert.equal(await readFile(path, "utf8"), "not-json");
});

test("concurrent seed and load updates preserve both ownership namespaces", async (t) => {
  // Given
  const path = await statePath(t);

  // When
  await Promise.all([
    appendSeedRoundId("seed-concurrent", { path }),
    setLoadRoundId("load-concurrent", { path }),
  ]);

  // Then
  assert.deepEqual(await readLoadTestRoundState({ path }), {
    version: 1,
    seedRoundIds: ["seed-concurrent"],
    loadRoundId: "load-concurrent",
  });
});
