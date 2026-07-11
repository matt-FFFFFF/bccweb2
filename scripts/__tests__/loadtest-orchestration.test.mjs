// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  LOADTEST_PHASES,
  parseOrchestrationReport,
  runLoadTestOrchestration,
} from "../lib/loadTestOrchestration.mjs";
import { createLoadTestCommands } from "../lib/loadTestOrchestrationCommands.mjs";

const PASSED = { exitCode: 0, signal: null };

function fixture({ failures = {}, checkpoint = "owned" } = {}) {
  const calls = [];
  const records = [];
  let time = 1_000;
  return {
    calls,
    records,
    run: () => runLoadTestOrchestration({
      runPhase: async (name) => {
        calls.push(name);
        return failures[name] ?? PASSED;
      },
      inspectCheckpoint: async () => {
        if (checkpoint === "corrupt") throw new Error("corrupt checkpoint");
        return checkpoint === "owned";
      },
      record: async (report) => records.push(structuredClone(report)),
      now: () => {
        time += 10;
        return time;
      },
    }),
  };
}

function status(report, name) {
  return report.phases.find((phase) => phase.name === name);
}

test("all phases run sequentially and all-success returns zero", async () => {
  // Given
  const scenario = fixture();

  // When
  const report = await scenario.run();

  // Then
  assert.deepEqual(scenario.calls, LOADTEST_PHASES);
  assert.equal(report.exitCode, 0);
  assert.ok(report.phases.every((phase) => phase.status === "passed"));
  assert.ok(scenario.records.some((entry) => entry.phases.some((phase) => phase.status === "running")));
});

test("prepare failure before checkpoint skips cleanup", async () => {
  // Given
  const scenario = fixture({ failures: { prepare: { exitCode: 23, signal: null } }, checkpoint: "absent" });

  // When
  const report = await scenario.run();

  // Then
  assert.deepEqual(scenario.calls, ["prepare"]);
  assert.equal(status(report, "prepare").exitCode, 23);
  assert.equal(status(report, "cleanup").status, "skipped");
  assert.equal(report.exitCode, 1);
});

test("prepare failure after checkpoint cleans exact owned state", async () => {
  // Given
  const scenario = fixture({ failures: { prepare: { exitCode: 17, signal: null } } });

  // When
  const report = await scenario.run();

  // Then
  assert.deepEqual(scenario.calls, ["prepare", "cleanup"]);
  assert.equal(status(report, "cleanup").status, "passed");
  assert.equal(report.exitCode, 1);
});

for (const failedPhase of ["register", "captains", "transition"]) {
  test(`${failedPhase} failure skips dependent phases and cleans checkpoint`, async () => {
    // Given
    const scenario = fixture({ failures: { [failedPhase]: { exitCode: 7, signal: null } } });

    // When
    const report = await scenario.run();

    // Then
    assert.deepEqual(scenario.calls, [
      ...LOADTEST_PHASES.slice(0, LOADTEST_PHASES.indexOf(failedPhase) + 1),
      "cleanup",
    ]);
    assert.equal(status(report, "sign").status, "skipped");
    assert.equal(report.exitCode, 1);
  });
}

test("sign exit failure still runs artifact and exact verification before permitted cleanup", async () => {
  // Given
  const scenario = fixture({ failures: { sign: { exitCode: 99, signal: null } } });

  // When
  const report = await scenario.run();

  // Then
  assert.deepEqual(scenario.calls, LOADTEST_PHASES);
  assert.equal(status(report, "sign").exitCode, 99);
  assert.equal(status(report, "verify").status, "passed");
  assert.equal(status(report, "cleanup").status, "passed");
  assert.equal(report.exitCode, 1);
});

test("artifact failure remains nonzero but exact verifier can permit cleanup", async () => {
  // Given
  const scenario = fixture({ failures: { artifact: { exitCode: 4, signal: null } } });

  // When
  const report = await scenario.run();

  // Then
  assert.deepEqual(scenario.calls, LOADTEST_PHASES);
  assert.equal(status(report, "artifact").status, "failed");
  assert.equal(status(report, "cleanup").status, "passed");
  assert.equal(report.exitCode, 1);
});

test("exact verifier or queue failure preserves diagnostics and forbids cleanup", async () => {
  // Given
  const scenario = fixture({ failures: { verify: { exitCode: 8, signal: null } } });

  // When
  const report = await scenario.run();

  // Then
  assert.deepEqual(scenario.calls, LOADTEST_PHASES.slice(0, -1));
  assert.equal(status(report, "cleanup").status, "skipped");
  assert.match(status(report, "cleanup").reason, /verification/);
  assert.equal(report.exitCode, 1);
});

test("cleanup failure is retained as an aggregate failure", async () => {
  // Given
  const scenario = fixture({ failures: { cleanup: { exitCode: 12, signal: null } } });

  // When
  const report = await scenario.run();

  // Then
  assert.equal(status(report, "cleanup").exitCode, 12);
  assert.equal(report.exitCode, 1);
});

test("signal termination is recorded exactly and follows phase failure policy", async () => {
  // Given
  const scenario = fixture({ failures: { register: { exitCode: null, signal: "SIGTERM" } } });

  // When
  const report = await scenario.run();

  // Then
  assert.equal(status(report, "register").signal, "SIGTERM");
  assert.deepEqual(scenario.calls, ["prepare", "register", "cleanup"]);
});

test("interruption before k6 spawn skips verification and cleans owned state", async () => {
  // Given
  const scenario = fixture({ failures: {
    sign: { exitCode: null, signal: "SIGINT", attempted: false },
  } });

  // When
  const report = await scenario.run();

  // Then
  assert.deepEqual(scenario.calls, ["prepare", "register", "captains", "transition", "sign", "cleanup"]);
  assert.equal(status(report, "artifact").status, "skipped");
  assert.equal(status(report, "verify").status, "skipped");
  assert.equal(status(report, "cleanup").status, "passed");
});

test("corrupt checkpoint fails closed by attempting cleanup", async () => {
  // Given
  const scenario = fixture({ failures: { prepare: { exitCode: 5, signal: null } }, checkpoint: "corrupt" });

  // When
  const report = await scenario.run();

  // Then
  assert.deepEqual(scenario.calls, ["prepare", "cleanup"]);
  assert.equal(status(report, "cleanup").status, "passed");
  assert.match(report.notes.join(" "), /corrupt checkpoint/);
  assert.equal(report.exitCode, 1);
});

test("status parser rejects corrupt artifacts and unknown phases", () => {
  // Given
  const unknownPhase = {
    version: 1,
    status: "failed",
    exitCode: 1,
    phases: [{ name: "invented", status: "skipped" }],
    notes: [],
  };

  // When / Then
  assert.throws(() => parseOrchestrationReport(null), /object/);
  assert.throws(() => parseOrchestrationReport(unknownPhase), /unknown phase invented/);
});

test("captured child output and secrets never enter aggregate status", async () => {
  // Given
  const records = [];

  // When
  const report = await runLoadTestOrchestration({
    runPhase: async () => ({ ...PASSED, stdout: "token=secret", stderr: "password=secret" }),
    inspectCheckpoint: async () => true,
    record: async (value) => records.push(JSON.stringify(value)),
    now: () => 1,
  });

  // Then
  assert.equal(report.exitCode, 0);
  assert.doesNotMatch(records.join("\n"), /token=secret|password=secret/u);
});

test("thrown SAS and connection-string errors are redacted before status persistence", async () => {
  // Given
  const records = [];

  // When
  const report = await runLoadTestOrchestration({
    runPhase: async () => {
      throw new Error("https://worker.invalid/blob?sv=2024&sig=status-secret AccountKey=key-secret");
    },
    inspectCheckpoint: async () => false,
    record: async (value) => records.push(JSON.stringify(value)),
    now: () => 1,
  });

  // Then
  assert.equal(report.exitCode, 1);
  assert.doesNotMatch(records.join("\n"), /status-secret|key-secret/u);
  assert.match(status(report, "prepare").error, /\[REDACTED\]/u);
});

test("returned child SAS errors are redacted before status persistence", async () => {
  // Given
  const records = [];

  // When
  const report = await runLoadTestOrchestration({
    runPhase: async () => ({
      exitCode: null,
      signal: null,
      error: "sig=returned-secret AccountKey=returned-key",
      timedOut: false,
    }),
    inspectCheckpoint: async () => false,
    record: async (value) => records.push(JSON.stringify(value)),
    now: () => 1,
  });

  // Then
  assert.equal(report.exitCode, 1);
  assert.doesNotMatch(records.join("\n"), /returned-secret|returned-key/u);
});

test("phase status records its safe captured-output path", async () => {
  // Given
  const outputPath = "/worker/logs/load-test/run-prepare.log";

  // When
  const report = await runLoadTestOrchestration({
    runPhase: async (name) => ({ ...PASSED, outputPath: `/worker/logs/load-test/run-${name}.log` }),
    inspectCheckpoint: async () => true,
    record: async () => undefined,
    now: () => 1,
  });

  // Then
  assert.equal(status(report, "prepare").outputPath, outputPath);
});

test("final status persistence failure makes an otherwise successful run nonzero", async () => {
  // Given
  let writes = 0;

  // When
  const report = await runLoadTestOrchestration({
    runPhase: async () => PASSED,
    inspectCheckpoint: async () => true,
    record: async () => {
      writes += 1;
      if (writes === 18) throw new Error("final write unavailable");
    },
    now: () => 1,
  });

  // Then
  assert.equal(report.exitCode, 1);
  assert.equal(report.status, "failed");
  assert.match(report.notes.join(" "), /final write unavailable/);
});

test("transition remains bounded but permits a loaded API to quiesce", () => {
  // Given
  const commands = createLoadTestCommands({
    root: "/worker",
    eventsPath: "/worker/events.json",
    summaryPath: "/worker/summary.json",
  });

  // When / Then
  assert.equal(commands.transition.timeoutMs, 10 * 60_000);
});
