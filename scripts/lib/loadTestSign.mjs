// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

export const SIGN_COHORTS = Object.freeze([
  Object.freeze({ name: "10", offset: 0, size: 10, startTime: "0s" }),
  Object.freeze({ name: "25", offset: 10, size: 25, startTime: "25s" }),
  Object.freeze({ name: "50", offset: 35, size: 50, startTime: "50s" }),
  Object.freeze({ name: "100", offset: 85, size: 100, startTime: "75s" }),
]);

const TARGET_COUNT = 185;

function fail(message) {
  throw new Error(`[loadtest-sign] ${message}`);
}

function parseSlot(slot, preparedIndex) {
  if (!slot || typeof slot !== "object") fail(`slot ${preparedIndex} must be an object`);
  if (typeof slot.teamId !== "string" || slot.teamId.length === 0) {
    fail(`slot ${preparedIndex} has invalid teamId`);
  }
  if (!Number.isInteger(slot.place) || slot.place < 1) fail(`slot ${preparedIndex} has invalid place`);
  if (typeof slot.pilotEmail !== "string" || slot.pilotEmail.length === 0) {
    fail(`slot ${preparedIndex} has invalid pilotEmail`);
  }
  if (typeof slot.pilotPassword !== "string" || slot.pilotPassword.length === 0) {
    fail(`slot ${preparedIndex} has invalid pilotPassword`);
  }
  return slot;
}

function cohortForIndex(preparedIndex) {
  const cohort = SIGN_COHORTS.find(({ offset, size }) => (
    preparedIndex >= offset && preparedIndex < offset + size
  ));
  if (!cohort) fail(`slot ${preparedIndex} is outside sign cohorts`);
  return cohort;
}

export function selectSignTargets(prepared) {
  if (!prepared || typeof prepared !== "object" || !Array.isArray(prepared.teams)) {
    fail("prepared teams must be an array");
  }
  if (prepared.teams.length < TARGET_COUNT) {
    fail(`expected at least ${TARGET_COUNT} prepared slots, received ${prepared.teams.length}`);
  }

  const parsed = prepared.teams.map(parseSlot);
  const keys = new Set();
  for (const slot of parsed) {
    const slotKey = `${slot.teamId}:${slot.place}`;
    if (keys.has(slotKey)) fail(`duplicate slot key ${slotKey}`);
    keys.add(slotKey);
  }
  return parsed.slice(0, TARGET_COUNT).map((slot, preparedIndex) => {
    const slotKey = `${slot.teamId}:${slot.place}`;
    return {
      cohort: cohortForIndex(preparedIndex).name,
      preparedIndex,
      slotKey,
      teamId: slot.teamId,
      place: slot.place,
      pilotEmail: slot.pilotEmail,
      pilotPassword: slot.pilotPassword,
    };
  });
}

export function buildSignOptions() {
  const scenarios = {};
  const thresholds = {
    "http_req_failed{phase:sign}": ["rate==0"],
  };
  for (const cohort of SIGN_COHORTS) {
    scenarios[`sign_${cohort.name}`] = {
      executor: "per-vu-iterations",
      exec: "signOnce",
      vus: cohort.size,
      iterations: 1,
      startTime: cohort.startTime,
      maxDuration: "20s",
      gracefulStop: "0s",
      env: { SIGN_COHORT: cohort.name },
      tags: { cohort: cohort.name, phase: "sign" },
    };
    thresholds[`sign_attempts{cohort:${cohort.name}}`] = [`count==${cohort.size}`];
    thresholds[`sign_created{cohort:${cohort.name}}`] = [`count==${cohort.size}`];
    thresholds[`sign_errors{cohort:${cohort.name}}`] = ["rate==0"];
    thresholds[`sign_5xx{cohort:${cohort.name}}`] = ["rate==0"];
    thresholds[`sign_duration{cohort:${cohort.name}}`] = ["p(95)<2000", "p(99)<5000"];
    thresholds[`http_reqs{phase:sign_setup,cohort:${cohort.name}}`] = [`count==${cohort.size}`];
    thresholds[`http_req_failed{phase:sign_setup,cohort:${cohort.name}}`] = ["rate==0"];
    thresholds[`sign_setup_attempts{cohort:${cohort.name}}`] = [`count==${cohort.size}`];
    thresholds[`sign_setup_errors{cohort:${cohort.name}}`] = ["rate==0"];
  }
  return {
    setupTimeout: "5m",
    batch: 25,
    batchPerHost: 25,
    summaryTrendStats: ["p(95)", "p(99)"],
    scenarios,
    thresholds,
  };
}

export function buildSignSummary(k6Summary) {
  return {
    contractVersion: 1,
    targets: SIGN_COHORTS.map(({ name, offset, size, startTime }) => ({
      cohort: name,
      offset,
      size,
      startTime,
    })),
    thresholds: {
      attempts: "exact",
      createdStatus: 201,
      errors: 0,
      serverErrors: 0,
      latencyMs: { p95: 2000, p99: 5000 },
    },
    metrics: k6Summary.metrics,
  };
}
