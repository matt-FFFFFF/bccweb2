// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../lib/loadTestCommandRunner.mjs";

test("runner captures both streams and preserves a child exit code", async () => {
  // Given
  const command = {
    command: process.execPath,
    args: ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(7)"],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 5_000,
  };

  // When
  const result = await runCommand(command);

  // Then
  assert.deepEqual(result, {
    exitCode: 7,
    signal: null,
    stdout: "out",
    stderr: "err",
    timedOut: false,
    error: null,
  });
});

test("runner preserves signal termination separately from exit code", async () => {
  // Given
  const command = {
    command: process.execPath,
    args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 5_000,
  };

  // When
  const result = await runCommand(command);

  // Then
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.timedOut, false);
});

test("runner reports spawn errors without inventing an exit code", async () => {
  // Given
  const command = {
    command: `missing-loadtest-command-${process.pid}`,
    args: [],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 5_000,
  };

  // When
  const result = await runCommand(command);

  // Then
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
  assert.match(result.error, /ENOENT/);
  assert.equal(result.timedOut, false);
});

test("runner bounds a hung child and records timeout signal", async () => {
  // Given
  const command = {
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1_000)"],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 30,
  };

  // When
  const result = await runCommand(command);

  // Then
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.timedOut, true);
});
