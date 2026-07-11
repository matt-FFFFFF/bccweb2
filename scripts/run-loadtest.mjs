#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BCC_API_BASE_URL } from "./lib/loadTestConsts.mjs";
import { runCommand } from "./lib/loadTestCommandRunner.mjs";
import { createInterruptionLatch } from "./lib/loadTestInterruption.mjs";
import { runLoadTestOrchestration } from "./lib/loadTestOrchestration.mjs";
import { createLoadTestCommands } from "./lib/loadTestOrchestrationCommands.mjs";
import { redactLoadTestOutput } from "./lib/loadTestOutputRedaction.mjs";
import {
  assertLoadTestArtifactPathsSafe,
  assertLoadTestTarget,
  resolveLoadTestArtifactPath,
} from "./lib/loadTestRuntimeGuard.mjs";
import { readLoadTestRoundState, writeJsonAtomically } from "./lib/loadTestRoundState.mjs";

const root = resolve(".");
const logDirectory = resolve("logs/load-test");
const runId = `${Date.now()}-${process.pid}`;
assertLoadTestTarget(BCC_API_BASE_URL, process.env.LOADTEST_DEDICATED_STACK === "1");
const eventsPath = resolveLoadTestArtifactPath(logDirectory, process.env.SIGN_EVENTS_PATH, `sign-events-${runId}.json`);
const summaryPath = resolveLoadTestArtifactPath(logDirectory, process.env.SIGN_SUMMARY_PATH, `sign-summary-${runId}.json`);
const statusPath = resolveLoadTestArtifactPath(logDirectory, process.env.LOADTEST_STATUS_PATH, `orchestration-${runId}.json`);
const commands = createLoadTestCommands({ root, eventsPath, summaryPath });
const interruption = createInterruptionLatch();
const phaseLogPaths = Object.fromEntries(
  Object.keys(commands).map((name) => [name, resolve(logDirectory, `${runId}-${name}.log`)]),
);
const artifactPaths = [eventsPath, summaryPath, statusPath, ...Object.values(phaseLogPaths)];

await assertLoadTestArtifactPathsSafe(root, artifactPaths);
await Promise.all([logDirectory, dirname(eventsPath), dirname(summaryPath), dirname(statusPath)].map(
  (directory) => mkdir(directory, { recursive: true }),
));
await assertLoadTestArtifactPathsSafe(root, artifactPaths);

function interrupt(signal) {
  console.error(`[loadtest] received ${signal}; terminating active phase safely`);
  interruption.interrupt(signal);
}

const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

async function runPhase(name) {
  const interrupted = interruption.beforePhase(name);
  if (interrupted !== null) return interrupted;
  if (name === "sign") interruption.markSignAttempted();
  const controller = new AbortController();
  interruption.setAbortActive(() => controller.abort());
  const result = await runCommand({ ...commands[name], signal: controller.signal });
  interruption.setAbortActive(() => undefined);
  const stdout = redactLoadTestOutput(result.stdout);
  const stderr = redactLoadTestOutput(result.stderr);
  const output = `${stdout}${stderr}`;
  const outputPath = phaseLogPaths[name];
  try {
    await assertLoadTestArtifactPathsSafe(root, [outputPath]);
    await writeFile(outputPath, output, { mode: 0o600 });
  } catch (error) {
    return {
      ...result,
      attempted: name === "sign" ? true : undefined,
      error: `output capture failed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
  if (stdout.length > 0) process.stdout.write(stdout);
  if (stderr.length > 0) process.stderr.write(stderr);
  return {
    ...result,
    attempted: name === "sign" ? true : undefined,
    outputPath,
  };
}

try {
  const report = await runLoadTestOrchestration({
    runPhase,
    inspectCheckpoint: async () => (await readLoadTestRoundState()).loadRoundId !== null,
    record: (value) => writeJsonAtomically(statusPath, value),
    now: Date.now,
  });
  console.error(`[loadtest] ${report.status}: status=${statusPath}`);
  process.exitCode = report.exitCode;
} catch (error) {
  console.error(`[loadtest] fatal: ${error instanceof Error ? error.message : "unknown error"}; status=${statusPath}`);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
