// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  withFixtureOperationLock,
  writeJsonDurably,
} from "../lib/fixtureOperation.mjs";

const RACE_CHILD = new URL("./helpers/fixtureLockRaceChild.mjs", import.meta.url);

function nextMessage(child) {
  return new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock race child exited early with ${code}`)));
  });
}

async function replaceLock(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path);
  const token = `${process.pid}-replacement`;
  await writeFile(join(path, `owner-${token}.json`), `${JSON.stringify({ pid: process.pid, token })}\n`);
}

test("durable JSON publication uses private mode and complete JSON", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fixture-operation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "manifest.json");
  await writeJsonDurably(path, { version: 1, ids: ["one"] });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, ids: ["one"] });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("fixture lock has bounded timeout while owner is live", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fixture-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, ".lock");
  await writeFile(path, `${process.pid}\n`);
  await assert.rejects(
    withFixtureOperationLock(async () => {}, { path, timeoutMs: 50 }),
    /fixture operation lock timeout/,
  );
});

test("fixture lock recovers a persisted dead owner", async (t) => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "fixture-lock-dead-owner-"));
  const path = join(directory, ".lock");
  const token = "dead-owner";
  await mkdir(path);
  await writeFile(join(path, `owner-${token}.json`), `${JSON.stringify({ pid: 2_147_483_647, token })}\n`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  let ran = false;

  // When
  await withFixtureOperationLock(async () => { ran = true; }, { path, timeoutMs: 100 });

  // Then
  assert.equal(ran, true);
});

test("stale reclaim cannot unlink another process replacement lock", async (t) => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "fixture-lock-reclaim-race-"));
  const path = join(directory, ".lock");
  const token = "stale-owner";
  await mkdir(path);
  await writeFile(join(path, `owner-${token}.json`), `${JSON.stringify({ pid: 2_147_483_647, token })}\n`);
  const child = fork(RACE_CHILD, ["reclaim", path], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { child.kill(); return rm(directory, { recursive: true, force: true }); });
  assert.equal(await nextMessage(child), "before-stale-unlink");

  // When
  await replaceLock(path);
  child.send("continue");

  // Then
  assert.deepEqual(await nextMessage(child), {
    outcome: "rejected",
    message: `fixture operation lock timeout: ${path}`,
  });
  assert.match((await readFile(join(path, `owner-${process.pid}-replacement.json`), "utf8")), /replacement/);
});

test("old owner release cannot unlink another process replacement lock", async (t) => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "fixture-lock-release-race-"));
  const path = join(directory, ".lock");
  const child = fork(RACE_CHILD, ["release", path], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { child.kill(); return rm(directory, { recursive: true, force: true }); });
  assert.equal(await nextMessage(child), "owned");
  child.send("continue");
  assert.equal(await nextMessage(child), "before-release-unlink");

  // When
  await replaceLock(path);
  child.send("continue");

  // Then
  assert.deepEqual(await nextMessage(child), { outcome: "resolved" });
  assert.match((await readFile(join(path, `owner-${process.pid}-replacement.json`), "utf8")), /replacement/);
});
