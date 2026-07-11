// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { parseSignAttemptEvents, parseSignSetupEvents } from "./loadTestSignArtifacts.mjs";
import { SIGN_COHORTS, selectSignTargets } from "./loadTestSign.mjs";

const PREPARED_COUNT = 500;
const SUMMARY_KEYS = new Set(["contractVersion", "targets", "thresholds", "metrics"]);
const TARGET_KEYS = new Set(["cohort", "offset", "size", "startTime"]);
const THRESHOLD_KEYS = new Set(["attempts", "createdStatus", "errors", "serverErrors", "latencyMs"]);
const LATENCY_KEYS = new Set(["p95", "p99"]);

function fail(message) {
  throw new Error(`[verify-loadtest-signtofly] ${message}`);
}

function fixedObject(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail(`${label} has unknown key ${unknown}`);
  return value;
}

function requireExactSummary(summary) {
  fixedObject(summary, SUMMARY_KEYS, "sign summary");
  if (summary.contractVersion !== 1) {
    fail("sign summary must have contractVersion 1");
  }
  if (!Array.isArray(summary.targets) || summary.targets.length !== SIGN_COHORTS.length) {
    fail("sign summary must define the four exact cohorts");
  }
  for (let index = 0; index < SIGN_COHORTS.length; index += 1) {
    const expected = SIGN_COHORTS[index];
    const actual = summary.targets[index];
    fixedObject(actual, TARGET_KEYS, `sign summary target ${expected.name}`);
    for (const field of ["name", "offset", "size", "startTime"]) {
      const summaryField = field === "name" ? "cohort" : field;
      if (actual?.[summaryField] !== expected[field]) {
        fail(`summary cohort ${expected.name} has invalid ${summaryField}; final100 must be offset 85 size 100`);
      }
    }
  }
  const thresholds = fixedObject(summary.thresholds, THRESHOLD_KEYS, "sign summary thresholds");
  const latencyMs = fixedObject(
    thresholds.latencyMs,
    LATENCY_KEYS,
    "sign summary thresholds latencyMs",
  );
  if (thresholds.attempts !== "exact" || thresholds.createdStatus !== 201 ||
      thresholds.errors !== 0 || thresholds.serverErrors !== 0 ||
      latencyMs.p95 !== 2_000 || latencyMs.p99 !== 5_000) {
    fail("sign summary thresholds do not match the exact verification contract");
  }
  fixedObject(summary.metrics, new Set(Object.keys(summary.metrics ?? {})), "sign summary metrics");
}

function exactSetupByKey(setupEvents, expectedTargets) {
  const setupByKey = new Map();
  for (const event of setupEvents) {
    if (setupByKey.has(event.slotKey)) fail(`duplicate setup key ${event.slotKey}`);
    if (event.status !== 200 || event.outcome !== "authenticated") {
      fail(`setup ${event.slotKey} outcome ${event.outcome} returned HTTP ${event.status}`);
    }
    setupByKey.set(event.slotKey, event);
  }
  for (const target of expectedTargets) {
    const event = setupByKey.get(target.slotKey);
    if (!event) fail(`missing setup key ${target.slotKey}`);
    if (event.cohort !== target.cohort) {
      fail(`setup ${target.slotKey} has cohort ${event.cohort}; expected ${target.cohort}`);
    }
    setupByKey.delete(target.slotKey);
  }
  if (setupByKey.size > 0) fail(`extra setup key ${setupByKey.keys().next().value}`);
}

export function parseVerificationArtifacts(prepared, events, summary) {
  if (!prepared || typeof prepared !== "object" ||
      typeof prepared.roundId !== "string" || prepared.roundId.trim().length === 0) {
    fail("PREPARED_ROUND_ID_INVALID: prepared artifact roundId must be a non-empty string");
  }
  if (!Array.isArray(prepared.teams) || prepared.teams.length !== PREPARED_COUNT) {
    fail(`prepared artifact must contain exactly ${PREPARED_COUNT} slots`);
  }
  requireExactSummary(summary);
  const expectedTargets = selectSignTargets(prepared);
  if (!Array.isArray(events)) fail("attempt artifacts must be an array");
  const eventByKey = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object" || typeof event.slotKey !== "string") {
      fail("attempt artifact has invalid slot key");
    }
    if (eventByKey.has(event.slotKey)) fail(`duplicate attempt key ${event.slotKey}`);
    eventByKey.set(event.slotKey, event);
  }
  const cohortCounts = Object.fromEntries(SIGN_COHORTS.map(({ name }) => [name, 0]));
  const targets = expectedTargets.map((target) => {
    const event = eventByKey.get(target.slotKey);
    if (!event) fail(`missing attempt key ${target.slotKey}`);
    if (event.cohort !== target.cohort) {
      fail(`attempt ${target.slotKey} has cohort ${event.cohort}; expected ${target.cohort}`);
    }
    if (typeof event.status !== "number" || typeof event.outcome !== "string" ||
        typeof event.signatureId !== "string") {
      fail(`attempt ${target.slotKey} has invalid projected fields`);
    }
    const created = event.status === 201 && event.outcome === "created" && event.signatureId !== "missing";
    const errorOutcomes = new Set(["request_error", "server_error", "http_error", "stale_replay"]);
    const errored = event.status !== 201 && errorOutcomes.has(event.outcome);
    if (!created && !errored) fail(`attempt ${target.slotKey} has invalid attempt result`);
    cohortCounts[target.cohort] += 1;
    eventByKey.delete(target.slotKey);
    return { ...target, event };
  });
  if (eventByKey.size > 0) fail(`extra attempt key ${eventByKey.keys().next().value}`);
  for (const { name, size } of SIGN_COHORTS) {
    if (cohortCounts[name] !== size) fail(`cohort ${name} recorded ${cohortCounts[name]}, expected ${size}`);
  }
  const final100 = targets.filter(({ cohort }) => cohort === "100");
  if (final100.length !== 100 || final100[0]?.preparedIndex !== 85 || final100[99]?.preparedIndex !== 184) {
    fail("final100 does not exactly cover prepared indices 85-184");
  }
  return { roundId: prepared.roundId, targets, final100, cohortCounts };
}

export function parseRawVerificationArtifacts(prepared, jsonLines, summary) {
  const setupEvents = parseSignSetupEvents(jsonLines);
  const attempts = parseSignAttemptEvents(jsonLines);
  const parsed = parseVerificationArtifacts(prepared, attempts, summary);
  exactSetupByKey(setupEvents, parsed.targets);
  return parsed;
}
