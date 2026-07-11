// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  withFixtureOperationLock,
  writeJsonDurably,
} from "../lib/fixtureOperation.mjs";

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
