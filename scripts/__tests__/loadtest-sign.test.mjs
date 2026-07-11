// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import {
  SIGN_COHORTS,
  buildSignOptions,
  buildSignSummary,
  selectSignTargets,
} from "../lib/loadTestSign.mjs";
import {
  parseSignAttemptEvents,
  parseSignSetupEvents,
  verifySignAttemptEvents,
  verifySignSummary,
} from "../lib/loadTestSignArtifacts.mjs";

const makefilePath = resolve("Makefile");
const signPhasePath = resolve("tests/load/sign-phase.js");
const signScriptPath = resolve("tests/load/sign-to-fly.js");

function preparedSlots(count = 500) {
  return Array.from({ length: count }, (_, index) => ({
    teamId: `team-${Math.floor(index / 10)}`,
    place: (index % 10) + 1,
    pilotEmail: `pilot-${index}@load.invalid`,
    pilotPassword: "fixture-password",
  }));
}

test("selector returns four disjoint ordered cohorts when 500 slots are prepared", () => {
  // Given
  const prepared = { teams: preparedSlots() };

  // When
  const targets = selectSignTargets(prepared);

  // Then
  assert.equal(targets.length, 185);
  assert.equal(new Set(targets.map(({ slotKey }) => slotKey)).size, 185);
  assert.deepEqual(
    SIGN_COHORTS.map(({ name }) => targets.filter((target) => target.cohort === name).length),
    [10, 25, 50, 100],
  );
  assert.deepEqual(
    SIGN_COHORTS.map(({ name }) => targets.filter((target) => target.cohort === name).map(({ preparedIndex }) => preparedIndex)),
    [
      Array.from({ length: 10 }, (_, index) => index),
      Array.from({ length: 25 }, (_, index) => index + 10),
      Array.from({ length: 50 }, (_, index) => index + 35),
      Array.from({ length: 100 }, (_, index) => index + 85),
    ],
  );
});

test("selector rejects fewer than 185 prepared slots", () => {
  // Given
  const prepared = { teams: preparedSlots(184) };

  // When / Then
  assert.throws(() => selectSignTargets(prepared), /at least 185/);
});

test("selector rejects duplicate prepared slot keys", () => {
  // Given
  const teams = preparedSlots();
  teams[184] = { ...teams[0] };

  // When / Then
  assert.throws(() => selectSignTargets({ teams }), /duplicate slot key team-0:1/);
});

test("selector rejects duplicate keys outside the selected cohorts", () => {
  // Given
  const teams = preparedSlots();
  teams[499] = { ...teams[498] };

  // When / Then
  assert.throws(() => selectSignTargets({ teams }), /duplicate slot key team-49:9/);
});

test("options define exact one-shot schedules and per-cohort gates", () => {
  // Given / When
  const options = buildSignOptions();

  // Then
  assert.equal(options.setupTimeout, "5m");
  assert.deepEqual(
    Object.values(options.scenarios).map(({ executor, vus, iterations, startTime, maxDuration, gracefulStop }) => ({
      executor,
      vus,
      iterations,
      startTime,
      maxDuration,
      gracefulStop,
    })),
    [
      { executor: "per-vu-iterations", vus: 10, iterations: 1, startTime: "0s", maxDuration: "20s", gracefulStop: "0s" },
      { executor: "per-vu-iterations", vus: 25, iterations: 1, startTime: "25s", maxDuration: "20s", gracefulStop: "0s" },
      { executor: "per-vu-iterations", vus: 50, iterations: 1, startTime: "50s", maxDuration: "20s", gracefulStop: "0s" },
      { executor: "per-vu-iterations", vus: 100, iterations: 1, startTime: "75s", maxDuration: "20s", gracefulStop: "0s" },
    ],
  );
  for (const { name, size } of SIGN_COHORTS) {
    assert.deepEqual(options.thresholds[`sign_attempts{cohort:${name}}`], [`count==${size}`]);
    assert.deepEqual(options.thresholds[`sign_created{cohort:${name}}`], [`count==${size}`]);
    assert.deepEqual(options.thresholds[`sign_errors{cohort:${name}}`], ["rate==0"]);
    assert.deepEqual(options.thresholds[`sign_5xx{cohort:${name}}`], ["rate==0"]);
    assert.deepEqual(options.thresholds[`sign_duration{cohort:${name}}`], ["p(95)<2000", "p(99)<5000"]);
    assert.deepEqual(options.thresholds[`http_reqs{phase:sign_setup,cohort:${name}}`], [`count==${size}`]);
    assert.deepEqual(options.thresholds[`sign_setup_attempts{cohort:${name}}`], [`count==${size}`]);
    assert.deepEqual(options.thresholds[`sign_setup_errors{cohort:${name}}`], ["rate==0"]);
  }
});

test("setup artifact parser preserves a bad credential slot without secrets", () => {
  // Given
  const line = JSON.stringify({
    metric: "sign_setup_attempts",
    type: "Point",
    data: { value: 1, tags: { cohort: "50", slot_key: "team-7:3", status: "401", outcome: "login_error" } },
  });

  // When
  const events = parseSignSetupEvents(`${line}\n`);

  // Then
  assert.deepEqual(events, [{ cohort: "50", slotKey: "team-7:3", status: 401, outcome: "login_error" }]);
  assert.doesNotMatch(JSON.stringify(events), /password|token|email/i);
});

test("summary carries exact public contract without credentials", () => {
  // Given
  const k6Summary = { metrics: { sign_attempts: { values: { count: 185 } } } };

  // When
  const summary = buildSignSummary(k6Summary);
  const encoded = JSON.stringify(summary);

  // Then
  assert.deepEqual(summary.targets.map(({ offset, size }) => ({ offset, size })), [
    { offset: 0, size: 10 },
    { offset: 10, size: 25 },
    { offset: 35, size: 50 },
    { offset: 85, size: 100 },
  ]);
  assert.deepEqual(summary.thresholds.latencyMs, { p95: 2000, p99: 5000 });
  assert.doesNotMatch(encoded, /password|token|pilotEmail/i);
});

test("artifact parser returns recoverable attempt evidence", () => {
  // Given
  const line = JSON.stringify({
    metric: "sign_attempts",
    type: "Point",
    data: {
      value: 1,
      tags: { cohort: "25", slot_key: "team-2:7", status: "201", signature_id: "sig-7", outcome: "created" },
    },
  });

  // When
  const events = parseSignAttemptEvents(`${line}\n`);

  // Then
  assert.deepEqual(events, [{
    cohort: "25",
    slotKey: "team-2:7",
    status: 201,
    signatureId: "sig-7",
    outcome: "created",
  }]);
});

test("artifact verifier accepts exactly 185 unique created attempts", () => {
  // Given
  const events = SIGN_COHORTS.flatMap(({ name, offset, size }) => (
    Array.from({ length: size }, (_, index) => ({
      cohort: name,
      slotKey: `team:${offset + index}`,
      status: 201,
      signatureId: `signature-${offset + index}`,
      outcome: "created",
    }))
  ));

  // When
  const report = verifySignAttemptEvents(events);

  // Then
  assert.deepEqual(report, {
    attempts: { 10: 10, 25: 25, 50: 50, 100: 100 },
    created: 185,
    uniqueSlots: 185,
    uniqueSignatures: 185,
    errors: 0,
    serverErrors: 0,
  });
});

test("summary verifier reads exact setup counts and passing cohort latency gates", () => {
  // Given
  const metrics = summaryMetrics();

  // When
  const report = verifySignSummary({ metrics });

  // Then
  assert.deepEqual(report, {
    setup: 185,
    latencyMs: {
      10: { p95: 120, p99: 240 },
      25: { p95: 120, p99: 240 },
      50: { p95: 120, p99: 240 },
      100: { p95: 120, p99: 240 },
    },
  });
});

test("summary verifier rejects a failed p99 threshold", () => {
  // Given
  const metrics = summaryMetrics();
  metrics["sign_duration{cohort:100}"].thresholds["p(99)<5000"].ok = false;

  // When / Then
  assert.throws(() => verifySignSummary({ metrics }), /cohort:100.*p\(99\)<5000/);
});

test("summary verifier rejects high latency hidden behind generic passing thresholds", () => {
  // Given
  const metrics = summaryMetrics();
  metrics["sign_duration{cohort:100}"] = {
    values: { "p(95)": 8_000, "p(99)": 9_000 },
    thresholds: { gate: { ok: true } },
  };

  // When / Then
  assert.throws(
    () => verifySignSummary({ metrics }),
    /cohort:100.*p\(95\)<2000|cohort:100.*p\(99\)<5000/,
  );
});

function passingMetric(values) {
  return {
    values,
    thresholds: {
      gate: { ok: true },
      "p(95)<2000": { ok: true },
      "p(99)<5000": { ok: true },
    },
  };
}

test("artifact verifier rejects a stale replay with its recoverable key", () => {
  // Given
  const events = SIGN_COHORTS.flatMap(({ name, offset, size }) => (
    Array.from({ length: size }, (_, index) => ({
      cohort: name,
      slotKey: `team:${offset + index}`,
      status: offset === 0 && index === 0 ? 200 : 201,
      signatureId: `signature-${offset + index}`,
      outcome: offset === 0 && index === 0 ? "stale_replay" : "created",
    }))
  ));

  // When / Then
  assert.throws(() => verifySignAttemptEvents(events), /team:0.*stale_replay.*HTTP 200/);
});

test("k6 and Make sources wire one-shot indices, bounded requests, and machine artifacts", async () => {
  // Given
  const [entry, phase, makefile] = await Promise.all([
    readFile(signScriptPath, "utf8"),
    readFile(signPhasePath, "utf8"),
    readFile(makefilePath, "utf8"),
  ]);

  // When / Then
  assert.doesNotMatch(entry, /ramping-vus|phase: "sign"|\/sign`/);
  assert.match(phase, /selectSignTargets\(PREPARED\)/);
  assert.match(phase, /exec\.scenario\.iterationInTest/);
  assert.doesNotMatch(phase, /__VU|%\s*data\.targets\.length|retry|sleep/);
  assert.match(phase, /http\.batch/);
  assert.match(phase, /offset \+= 25/);
  assert.match(phase, /tokens\.has\(token\)/);
  assert.match(phase, /failures\.push/);
  assert.match(phase, /if \(failures\.length > 0\)/);
  assert.match(phase, /timeout: "30s"/);
  assert.match(phase, /timeout: "15s"/);
  assert.match(phase, /status === 201/);
  assert.match(phase, /if \(created\) signCreated\.add\(1, tags\)/);
  assert.match(phase, /signErrors\.add\(created \? 0 : 1, tags\)/);
  assert.match(phase, /sign5xx\.add\(response\.status >= 500 \? 1 : 0, tags\)/);
  assert.match(phase, /signature_id/);
  assert.match(makefile, /SIGN_EVENTS_PATH/);
  assert.match(makefile, /SIGN_SUMMARY_PATH/);
  assert.match(makefile, /--out json=/);
  assert.match(makefile, /--summary-trend-stats.*p\(95\).*p\(99\)/);
  assert.match(makefile, /verify-loadtest-sign-artifacts\.mjs/);
});

function summaryMetrics() {
  const metrics = {};
  for (const { name, size } of SIGN_COHORTS) {
    metrics[`http_reqs{phase:sign_setup,cohort:${name}}`] = passingMetric({ count: size });
    metrics[`http_req_failed{phase:sign_setup,cohort:${name}}`] = passingMetric({ rate: 0 });
    metrics[`sign_setup_attempts{cohort:${name}}`] = passingMetric({ count: size });
    metrics[`sign_setup_errors{cohort:${name}}`] = passingMetric({ rate: 0 });
    metrics[`sign_attempts{cohort:${name}}`] = passingMetric({ count: size });
    metrics[`sign_created{cohort:${name}}`] = passingMetric({ count: size });
    metrics[`sign_errors{cohort:${name}}`] = passingMetric({ rate: 0 });
    metrics[`sign_5xx{cohort:${name}}`] = passingMetric({ rate: 0 });
    metrics[`sign_duration{cohort:${name}}`] = passingMetric({ "p(95)": 120, "p(99)": 240 });
  }
  return metrics;
}
