// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assertLoadTestArtifactPathsSafe,
  assertLoadTestTarget,
  resolveLoadTestArtifactPath,
} from "../lib/loadTestRuntimeGuard.mjs";

test("target guard accepts only explicitly dedicated loopback and remote hosts", () => {
  // Given / When / Then
  assert.doesNotThrow(() => assertLoadTestTarget("http://127.0.0.1:7071", true));
  assert.doesNotThrow(() => assertLoadTestTarget("http://localhost:7071", true));
  assert.doesNotThrow(() => assertLoadTestTarget("https://bcc-loadtest.example.test", true));
  assert.doesNotThrow(() => assertLoadTestTarget("https://bcc-staging.example.test", true));
});

test("target guard rejects production-looking and unclassified remote hosts", () => {
  // Given / When / Then
  assert.throws(() => assertLoadTestTarget("https://api.example.test"), /loadtest or staging/);
  assert.throws(() => assertLoadTestTarget("http://127.0.0.1:7071"), /dedicated stack/);
  assert.throws(() => assertLoadTestTarget("https://bcc-loadtest.example.test", false), /dedicated stack/);
  assert.throws(() => assertLoadTestTarget("https://prodloadtest.example.test", true), /production-looking/);
  assert.throws(() => assertLoadTestTarget("https://loadtest-prodfoo.example.test", true), /production-looking/);
  assert.throws(() => assertLoadTestTarget("not a url"), /valid URL/);
  assert.throws(() => assertLoadTestTarget("ftp://bcc-loadtest.example.test", true), /http or https/);
});

test("artifact paths are confined beneath the private load log directory", () => {
  // Given
  const directory = "/worker/logs/load-test";

  // When / Then
  assert.equal(resolveLoadTestArtifactPath(directory, undefined, "status.json"), `${directory}/status.json`);
  assert.equal(resolveLoadTestArtifactPath(directory, "nested/status.json", "ignored.json"), `${directory}/nested/status.json`);
  assert.throws(() => resolveLoadTestArtifactPath(directory, "/etc/status.json", "ignored.json"), /must be relative/);
  assert.throws(() => resolveLoadTestArtifactPath(directory, "../status.json", "ignored.json"), /inside/);
});

test("artifact safety rejects symlink path components", async () => {
  // Given
  const root = "/worker";
  const path = "/worker/logs/load-test/status.json";
  const lstat = async (candidate) => {
    if (candidate === "/worker/logs") return { isSymbolicLink: () => true };
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  };

  // When / Then
  await assert.rejects(
    () => assertLoadTestArtifactPathsSafe(root, [path], { lstat }),
    /symbolic link.*logs/u,
  );
});

test("artifact safety also rejects generated phase-log symlinks", async () => {
  // Given
  const root = "/worker";
  const phaseLog = "/worker/logs/load-test/run-prepare.log";
  const lstat = async (candidate) => {
    if (candidate === phaseLog) return { isSymbolicLink: () => true };
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  };

  // When / Then
  await assert.rejects(
    () => assertLoadTestArtifactPathsSafe(root, [phaseLog], { lstat }),
    /symbolic link.*run-prepare\.log/u,
  );
});

test("CLI rejects a production-looking target before creating runtime state", async (t) => {
  // Given
  const cwd = await mkdtemp(join(tmpdir(), "bcc-load-guard-"));
  const script = resolve("scripts/run-loadtest.mjs");
  t.after(() => rm(cwd, { recursive: true, force: true }));

  // When
  const result = spawnSync(process.execPath, [script], {
    cwd,
    env: { ...process.env, BCC_API_BASE_URL: "https://loadtest-prod.example.test" },
    encoding: "utf8",
  });

  // Then
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production-looking/);
  assert.equal(existsSync(join(cwd, "logs")), false);
});

test("CLI redacts credential-bearing initialization errors", async (t) => {
  // Given
  const cwd = await mkdtemp(join(tmpdir(), "bcc-load-init-error-"));
  const script = resolve("scripts/run-loadtest.mjs");
  t.after(() => rm(cwd, { recursive: true, force: true }));

  // When
  const result = spawnSync(process.execPath, [script], {
    cwd,
    env: {
      ...process.env,
      BCC_API_BASE_URL: "http://127.0.0.1:7071",
      LOADTEST_DEDICATED_STACK: "1",
      LOADTEST_STATUS_PATH: "status.json?sv=2024&sig=init-secret",
    },
    encoding: "utf8",
  });

  // Then
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /init-secret/u);
});
