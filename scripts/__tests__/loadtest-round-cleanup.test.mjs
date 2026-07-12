// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { cleanupLoadRound } from "../cleanup-loadtest.mjs";
import { cleanupOwnedRoundIds } from "../lib/loadTestRoundCleanup.mjs";

test("cleanup removes only explicit round IDs and their exact references", async () => {
  // Given
  const deleted = [];
  const listed = [];
  const writes = [];
  const blobs = {
    readJson: async (container, path) => {
      if (container === "private" && path === "rounds/owned.json") {
        return { season: { year: 2026 } };
      }
      if (container === "public" && path === "rounds.json") {
        return [{ id: "owned", seasonYear: 2026 }, { id: "unrelated", seasonYear: 2026 }];
      }
      if (container === "public" && path === "seasons/2026.json") {
        return { year: 2026, rounds: ["owned", "unrelated"] };
      }
      return null;
    },
    writeJson: async (container, path, value) => writes.push({ container, path, value }),
    deleteBlob: async (container, path) => deleted.push({ container, path }),
    listBlobs: async function* (container, prefix) {
      listed.push({ container, prefix });
      if (prefix === "signatures/owned/") yield "signatures/owned/one.json";
      if (prefix === "round-briefs/owned/") yield "round-briefs/owned/image.png";
    },
  };

  // When
  const result = await cleanupOwnedRoundIds(["owned"], {
    blobs,
    privateContainer: "private",
    publicContainer: "public",
  });

  // Then
  assert.deepEqual(result, { roundCount: 1, signatureCount: 1 });
  assert.ok(listed.every(({ prefix }) => prefix.includes("owned/")));
  assert.ok(listed.every(({ prefix }) => prefix !== "rounds/"));
  assert.ok(deleted.every(({ path }) => !path.includes("unrelated")));
  assert.deepEqual(writes.find(({ path }) => path === "rounds.json")?.value, [{ id: "unrelated", seasonYear: 2026 }]);
  assert.deepEqual(writes.find(({ path }) => path === "seasons/2026.json")?.value.rounds, ["unrelated"]);
});

test("cleanup removes season references before deleting recovery metadata", async () => {
  // Given
  const operations = [];
  const blobs = {
    readJson: async (container, path) => {
      if (container === "private" && path === "rounds/owned.json") return { season: { year: 2026 } };
      if (path === "rounds.json") return [{ id: "owned", seasonYear: 2026 }];
      if (path === "seasons/2026.json") return { year: 2026, rounds: ["owned"] };
      return null;
    },
    writeJson: async (_container, path) => operations.push(`write:${path}`),
    deleteBlob: async (_container, path) => operations.push(`delete:${path}`),
    listBlobs: async function* () {},
  };

  // When
  await cleanupOwnedRoundIds(["owned"], { blobs, privateContainer: "private", publicContainer: "public" });

  // Then
  assert.ok(operations.indexOf("write:seasons/2026.json") < operations.indexOf("write:rounds.json"));
  assert.ok(operations.indexOf("write:seasons/2026.json") < operations.indexOf("delete:rounds/owned.json"));
});

test("load cleanup consumes checkpoint ownership without prepared metadata", async () => {
  // Given
  const calls = [];

  // When
  const result = await cleanupLoadRound({
    readState: async () => ({ version: 1, seedRoundIds: ["seed-preserved"], loadRoundId: "load-orphan" }),
    cleanup: async (roundIds) => {
      calls.push({ kind: "cleanup", roundIds });
      return { roundCount: roundIds.length, signatureCount: 0 };
    },
    clearLoadRoundId: async () => calls.push({ kind: "clear" }),
    removePrepared: () => calls.push({ kind: "prepared" }),
  });

  // Then
  assert.deepEqual(result, { roundId: "load-orphan", roundCount: 1, signatureCount: 0 });
  assert.deepEqual(calls, [
    { kind: "cleanup", roundIds: ["load-orphan"] },
    { kind: "clear" },
    { kind: "prepared" },
  ]);
});

test("load cleanup removes stale prepared metadata without guessing a round", async () => {
  // Given
  const calls = [];

  // When
  const result = await cleanupLoadRound({
    readState: async () => ({ version: 1, seedRoundIds: ["seed-preserved"], loadRoundId: null }),
    cleanup: async () => calls.push({ kind: "unexpected-cleanup" }),
    clearLoadRoundId: async () => calls.push({ kind: "unexpected-clear" }),
    removePrepared: () => calls.push({ kind: "prepared" }),
  });

  // Then
  assert.deepEqual(result, { roundId: null, roundCount: 0, signatureCount: 0 });
  assert.deepEqual(calls, [{ kind: "prepared" }]);
});
