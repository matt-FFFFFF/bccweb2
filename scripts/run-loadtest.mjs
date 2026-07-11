#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BCC_API_BASE_URL } from "./lib/loadTestConsts.mjs";
import { runCommand } from "./lib/loadTestCommandRunner.mjs";
import { createInterruptionLatch } from "./lib/loadTestInterruption.mjs";
import { LOADTEST_PHASES, runLoadTestOrchestration } from "./lib/loadTestOrchestration.mjs";
import { createLoadTestCommands } from "./lib/loadTestOrchestrationCommands.mjs";
import { redactLoadTestOutput } from "./lib/loadTestOutputRedaction.mjs";
import { openPrivateOutput } from "./lib/loadTestSafeOutput.mjs";
import {
  assertLoadTestArtifactPathsSafe,
  assertLoadTestTarget,
  resolveLoadTestArtifactPath,
} from "./lib/loadTestRuntimeGuard.mjs";
import { readLoadTestRoundState } from "./lib/loadTestRoundState.mjs";

function safeMessage(error) {
  return redactLoadTestOutput(error instanceof Error ? error.message : "unknown error");
}

async function main() {
  const root = resolve(".");
  const logDirectory = resolve("logs/load-test");
  const runId = `${Date.now()}-${process.pid}`;
  assertLoadTestTarget(BCC_API_BASE_URL, process.env.LOADTEST_DEDICATED_STACK === "1");
  const eventsPath = resolveLoadTestArtifactPath(logDirectory, process.env.SIGN_EVENTS_PATH, `sign-events-${runId}.json`);
  const summaryPath = resolveLoadTestArtifactPath(logDirectory, process.env.SIGN_SUMMARY_PATH, `sign-summary-${runId}.json`);
  const statusPath = resolveLoadTestArtifactPath(logDirectory, process.env.LOADTEST_STATUS_PATH, `orchestration-${runId}.json`);
  const phaseLogPaths = Object.fromEntries(
    LOADTEST_PHASES.map((name) => [name, resolve(logDirectory, `${runId}-${name}.log`)]),
  );
  const artifactPaths = [eventsPath, summaryPath, statusPath, ...Object.values(phaseLogPaths)];
  const outputs = [];
  let transactionCompleted = false;
  let operationError;
  let closeError;

  await assertLoadTestArtifactPathsSafe(root, artifactPaths);
  await Promise.all([logDirectory, dirname(eventsPath), dirname(summaryPath), dirname(statusPath)].map(
    (directory) => mkdir(directory, { recursive: true, mode: 0o700 }),
  ));
  await assertLoadTestArtifactPathsSafe(root, artifactPaths);

  try {
    const eventsOutput = await openPrivateOutput(root, eventsPath); outputs.push(eventsOutput);
    const summaryOutput = await openPrivateOutput(root, summaryPath); outputs.push(summaryOutput);
    const statusOutput = await openPrivateOutput(root, statusPath); outputs.push(statusOutput);
    const phaseLogOutputs = {};
    for (const [name, path] of Object.entries(phaseLogPaths)) {
      phaseLogOutputs[name] = await openPrivateOutput(root, path);
      outputs.push(phaseLogOutputs[name]);
    }
    await eventsOutput.prepareExternalWrite();
    await summaryOutput.prepareExternalWrite();
    const commands = createLoadTestCommands({
      root,
      eventsPath: "/dev/fd/3",
      summaryPath: "/dev/fd/4",
      artifactStdio: [eventsOutput.fd, summaryOutput.fd],
    });
    const interruption = createInterruptionLatch();

    const interrupt = (signal) => {
      console.error(`[loadtest] received ${signal}; terminating active phase safely`);
      interruption.interrupt(signal);
    };
    const onSigint = () => interrupt("SIGINT");
    const onSigterm = () => interrupt("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    const openReaders = async () => {
      const readers = [];
      try {
        readers.push(await eventsOutput.openReader());
        readers.push(await summaryOutput.openReader());
        return readers;
      } catch (error) {
        await Promise.allSettled(readers.map((reader) => reader.close()));
        throw error;
      }
    };
    const runPhase = async (name) => {
      const interrupted = interruption.beforePhase(name);
      if (interrupted !== null) return interrupted;
      if (name === "sign") interruption.markSignAttempted();
      const controller = new AbortController();
      interruption.setAbortActive(() => controller.abort());
      let readers = [];
      let result;
      try {
        if (name === "artifact" || name === "verify") readers = await openReaders();
        const command = readers.length === 0
          ? commands[name]
          : { ...commands[name], extraStdio: readers.map(({ fd }) => fd) };
        result = await runCommand({ ...command, signal: controller.signal });
      } finally {
        await Promise.allSettled(readers.map((reader) => reader.close()));
        interruption.setAbortActive(() => undefined);
      }
      const stdout = redactLoadTestOutput(result.stdout);
      const stderr = redactLoadTestOutput(result.stderr);
      try {
        await phaseLogOutputs[name].replace(`${stdout}${stderr}`);
        await eventsOutput.verify();
        await summaryOutput.verify();
      } catch (error) {
        return { ...result, attempted: name === "sign" ? true : undefined, error: `output capture failed: ${safeMessage(error)}` };
      }
      if (stdout.length > 0) process.stdout.write(stdout);
      if (stderr.length > 0) process.stderr.write(stderr);
      return { ...result, attempted: name === "sign" ? true : undefined, outputPath: phaseLogPaths[name] };
    };

    try {
      const report = await runLoadTestOrchestration({
        runPhase,
        inspectCheckpoint: async () => (await readLoadTestRoundState()).loadRoundId !== null,
        record: (value) => statusOutput.replace(`${JSON.stringify(value, null, 2)}\n`),
        now: Date.now,
      });
      process.exitCode = report.exitCode;
      transactionCompleted = true;
      console.error(redactLoadTestOutput(`[loadtest] ${report.status}: status=${statusPath}`));
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  } catch (error) {
    operationError = error;
  } finally {
    const results = await Promise.allSettled(outputs.map((output) => (
      transactionCompleted ? output.close() : output.abort()
    )));
    const failure = results.find(({ status }) => status === "rejected");
    if (failure?.status === "rejected") closeError = failure.reason;
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
}

main().catch((error) => {
  console.error(`[loadtest] fatal: ${safeMessage(error)}`);
  process.exitCode = 1;
});
