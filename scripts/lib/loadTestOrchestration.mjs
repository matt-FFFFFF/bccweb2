// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { redactLoadTestOutput } from "./loadTestOutputRedaction.mjs";

export const LOADTEST_PHASES = [
  "prepare",
  "register",
  "captains",
  "transition",
  "sign",
  "artifact",
  "verify",
  "cleanup",
];

const PRE_SIGN_PHASES = LOADTEST_PHASES.slice(0, 4);
const PHASE_STATUSES = new Set(["pending", "running", "passed", "failed", "skipped"]);

function skippedPhase(name) {
  return { name, status: "pending", reason: "not attempted" };
}

function resultPassed(result) {
  return result.exitCode === 0 && result.signal === null && result.error == null && result.timedOut !== true;
}

function errorMessage(error) {
  return redactLoadTestOutput(error instanceof Error ? error.message : "unknown error");
}

function parsePhase(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("orchestration phase must be an object");
  }
  if (!LOADTEST_PHASES.includes(value.name)) throw new Error(`unknown phase ${String(value.name)}`);
  if (!PHASE_STATUSES.has(value.status)) throw new Error(`invalid phase status ${String(value.status)}`);
  return structuredClone(value);
}

export function parseOrchestrationReport(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("orchestration report must be an object");
  }
  if (value.version !== 1 || !Array.isArray(value.phases) || !Array.isArray(value.notes)) {
    throw new Error("orchestration report has invalid shape");
  }
  const phases = value.phases.map(parsePhase);
  if (new Set(phases.map(({ name }) => name)).size !== phases.length) {
    throw new Error("orchestration report has duplicate phases");
  }
  return { ...structuredClone(value), phases };
}

export async function runLoadTestOrchestration(options) {
  const { runPhase, inspectCheckpoint, record, now } = options;
  const report = {
    version: 1,
    status: "running",
    exitCode: null,
    startedAtMs: now(),
    phases: LOADTEST_PHASES.map(skippedPhase),
    notes: [],
  };
  let recordingFailed = false;

  const persist = async () => {
    try {
      await record(report);
      return true;
    } catch (error) {
      recordingFailed = true;
      const note = `status recording failed: ${errorMessage(error)}`;
      if (!report.notes.includes(note)) report.notes.push(note);
      return false;
    }
  };
  const phase = (name) => report.phases.find((candidate) => candidate.name === name);
  const skip = (name, reason) => Object.assign(phase(name), { status: "skipped", reason });
  const execute = async (name) => {
    const current = phase(name);
    const startedAtMs = now();
    Object.assign(current, { status: "running", startedAtMs, reason: undefined });
    await persist();
    let result;
    try {
      result = await runPhase(name);
    } catch (error) {
      result = { exitCode: null, signal: null, error: errorMessage(error), timedOut: false };
    }
    const finishedAtMs = now();
    Object.assign(current, {
      status: resultPassed(result) ? "passed" : "failed",
      finishedAtMs,
      durationMs: finishedAtMs - startedAtMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut === true,
      error: typeof result.error === "string" ? redactLoadTestOutput(result.error) : null,
      outputPath: typeof result.outputPath === "string" ? result.outputPath : undefined,
      attempted: typeof result.attempted === "boolean" ? result.attempted : undefined,
    });
    await persist();
    return current.status === "passed";
  };
  const checkpointExists = async () => {
    try {
      return await inspectCheckpoint();
    } catch (error) {
      report.notes.push(`checkpoint inspection failed: ${errorMessage(error)}`);
      return true;
    }
  };
  const finish = async () => {
    for (const current of report.phases) {
      if (current.status === "pending") skip(current.name, "not reached");
    }
    report.finishedAtMs = now();
    report.status = report.phases.every(({ status }) => status === "passed") && !recordingFailed
      ? "passed"
      : "failed";
    report.exitCode = report.status === "passed" ? 0 : 1;
    const recorded = await persist();
    if (!recorded) {
      report.status = "failed";
      report.exitCode = 1;
    }
    return parseOrchestrationReport(report);
  };

  await persist();
  for (const name of PRE_SIGN_PHASES) {
    if (await execute(name)) continue;
    const failedIndex = PRE_SIGN_PHASES.indexOf(name);
    for (const dependent of PRE_SIGN_PHASES.slice(failedIndex + 1)) skip(dependent, `${name} failed`);
    for (const dependent of ["sign", "artifact", "verify"]) skip(dependent, `${name} failed`);
    if (await checkpointExists()) await execute("cleanup");
    else skip("cleanup", "no owned load-round checkpoint");
    return finish();
  }

  await execute("sign");
  if (phase("sign").attempted === false) {
    skip("artifact", "sign was not attempted");
    skip("verify", "sign was not attempted");
    if (await checkpointExists()) await execute("cleanup");
    else skip("cleanup", "no owned load-round checkpoint");
    return finish();
  }
  await execute("artifact");
  const verified = await execute("verify");
  if (verified) await execute("cleanup");
  else skip("cleanup", "exact verification or queue quiescence failed; diagnostics preserved");
  return finish();
}
