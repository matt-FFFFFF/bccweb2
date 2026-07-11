// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { openPrivateOutput } from "../lib/loadTestSafeOutput.mjs";
import { runCommand } from "../lib/loadTestCommandRunner.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bcc-safe-output-"));
  const directory = join(root, "logs", "load-test");
  await mkdir(directory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory };
}

test("hard-linked output is rejected without changing the outside sentinel", async (t) => {
  // Given
  const { root, directory } = await fixture(t);
  const sentinel = join(root, "sentinel.txt");
  const output = join(directory, "phase.log");
  await writeFile(sentinel, "outside-safe", { mode: 0o600 });
  await link(sentinel, output);

  // When / Then
  await assert.rejects(() => openPrivateOutput(root, output), /single-link/);
  assert.equal(await readFile(sentinel, "utf8"), "outside-safe");
});

test("existing owned 0644 log is tightened before replacement", async (t) => {
  // Given
  const { root, directory } = await fixture(t);
  const output = join(directory, "phase.log");
  await writeFile(output, "stale", { mode: 0o644 });
  await chmod(output, 0o644);

  // When
  const file = await openPrivateOutput(root, output);
  await file.replace("fresh");
  await file.close();

  // Then
  assert.equal(await readFile(output, "utf8"), "fresh");
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
});

test("final-path symlink swap after open is rejected without touching sentinel", async (t) => {
  // Given
  const { root, directory } = await fixture(t);
  const output = join(directory, "phase.log");
  const displaced = join(directory, "phase-owned.log");
  const sentinel = join(root, "sentinel.txt");
  await writeFile(output, "old", { mode: 0o600 });
  await writeFile(sentinel, "outside-safe", { mode: 0o600 });

  // When
  const file = await openPrivateOutput(root, output, {
    beforePublish: async () => {
      await rename(output, displaced);
      await symlink(sentinel, output);
    },
  });

  // Then
  await assert.rejects(() => file.replace("attack"), /binding changed/);
  await file.abort();
  assert.equal(await readFile(sentinel, "utf8"), "outside-safe");
});

test("parent-component swap after open is rejected without touching sentinel", async (t) => {
  // Given
  const { root, directory } = await fixture(t);
  const output = join(directory, "phase.log");
  const originalDirectory = `${directory}-owned`;
  const outsideDirectory = join(root, "outside");
  const sentinel = join(outsideDirectory, "phase.log");
  await mkdir(outsideDirectory);
  await writeFile(sentinel, "outside-safe", { mode: 0o600 });

  // When
  const file = await openPrivateOutput(root, output, {
    beforePublish: async () => {
      await rename(directory, originalDirectory);
      await symlink(outsideDirectory, directory, "dir");
    },
  });

  // Then
  await assert.rejects(() => file.replace("attack"), /parent binding changed/);
  await file.abort();
  assert.equal(await readFile(sentinel, "utf8"), "outside-safe");
});

test("destination hardlink replacement immediately before publication is rejected", async (t) => {
  // Given
  const { root, directory } = await fixture(t);
  const output = join(directory, "status.json");
  const displaced = join(directory, "status-owned.json");
  const sentinel = join(root, "sentinel.txt");
  await writeFile(output, "old", { mode: 0o600 });
  await writeFile(sentinel, "outside-safe", { mode: 0o600 });
  const file = await openPrivateOutput(root, output, {
    beforePublish: async () => {
      await rename(output, displaced);
      await link(sentinel, output);
    },
  });

  // When / Then
  await assert.rejects(() => file.replace("attack"), /binding changed|single-link/);
  await file.abort();
  assert.equal(await readFile(sentinel, "utf8"), "outside-safe");
});

test("external writer receives an already-open private descriptor", async (t) => {
  // Given
  const { root, directory } = await fixture(t);
  const output = join(directory, "events.json");

  // When
  const file = await openPrivateOutput(root, output);
  const fd = await file.prepareExternalWrite();

  // Then
  assert.equal(fd, file.fd);
  assert.ok((constants.O_NOFOLLOW ?? 0) >= 0);
  assert.equal((await file.stat()).mode & 0o777, 0o600);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  await file.abort();
});

test("child writes through inherited descriptor and verifier reads from a fresh offset-zero descriptor", async (t) => {
  // Given
  const { root, directory } = await fixture(t);
  const output = join(directory, "events.json");
  const file = await openPrivateOutput(root, output);
  await file.prepareExternalWrite();

  // When
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "require('fs').writeFileSync('/dev/fd/3', 'descriptor-data')"],
    cwd: root,
    env: {},
    timeoutMs: 5_000,
    extraStdio: [file.fd],
  });
  const reader = await file.openReader();
  const verifyResult = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write(require('fs').readFileSync('/dev/fd/3', 'utf8'))"],
    cwd: root,
    env: {},
    timeoutMs: 5_000,
    extraStdio: [reader.fd],
  });

  // Then
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(verifyResult.stdout, "descriptor-data");
  assert.equal(await file.readText(), "descriptor-data");
  await reader.close();
  await file.close();
});

test("CLI rejects a configured hard-linked status without modifying its sentinel", async (t) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "bcc-safe-cli-hardlink-"));
  const logDirectory = join(root, "logs", "load-test");
  const sentinel = join(root, "sentinel.txt");
  const status = join(logDirectory, "status.json");
  await mkdir(logDirectory, { recursive: true });
  await writeFile(sentinel, "outside-safe", { mode: 0o600 });
  await link(sentinel, status);
  t.after(() => rm(root, { recursive: true, force: true }));

  // When
  const result = await runCommand({
    command: process.execPath,
    args: [resolve("scripts/run-loadtest.mjs")],
    cwd: root,
    env: { BCC_API_BASE_URL: "http://127.0.0.1:7071", LOADTEST_STATUS_PATH: "status.json" },
    timeoutMs: 5_000,
  });

  // Then
  assert.notEqual(result.exitCode, 0);
  assert.equal(await readFile(sentinel, "utf8"), "outside-safe");
});

test("CLI spawn failure publishes exact private status and logs", async (t) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "bcc-safe-cli-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // When
  const result = await runCommand({
    command: process.execPath,
    args: [resolve("scripts/run-loadtest.mjs")],
    cwd: root,
    env: { BCC_API_BASE_URL: "http://127.0.0.1:7071" },
    timeoutMs: 10_000,
  });

  // Then
  assert.equal(result.exitCode, 1, result.stderr);
  const directory = join(root, "logs", "load-test");
  const entries = await readdir(directory);
  const statusName = entries.find((name) => name.startsWith("orchestration-") && name.endsWith(".json"));
  assert.ok(statusName);
  const status = JSON.parse(await readFile(join(directory, statusName), "utf8"));
  assert.deepEqual(status.phases.map(({ name }) => name), [
    "prepare", "register", "captains", "transition", "sign", "artifact", "verify", "cleanup",
  ]);
  for (const entry of entries) assert.equal((await lstat(join(directory, entry))).mode & 0o777, 0o600);
});
