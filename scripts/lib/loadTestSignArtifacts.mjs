// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { SIGN_COHORTS } from "./loadTestSign.mjs";

function fail(message) {
  throw new Error(`[loadtest-sign] ${message}`);
}

function parseEvents(jsonLines, metricName, fields) {
  const expectedTags = [...fields].sort();
  const events = [];
  for (const line of jsonLines.split("\n")) {
    if (line.trim().length === 0) continue;
    const event = JSON.parse(line);
    if (event.metric !== metricName || event.type !== "Point") continue;
    if (event.data?.value !== 1) fail(`${metricName} event has invalid value`);
    const tags = event.data.tags;
    if (!tags || typeof tags !== "object") fail(`${metricName} event is missing tags`);
    const actualTags = Object.keys(tags).sort();
    for (const key of actualTags) {
      if (!expectedTags.includes(key)) fail(`${metricName} event has unknown tag ${key}`);
    }
    for (const key of expectedTags) {
      if (!actualTags.includes(key)) fail(`${metricName} event is missing tag ${key}`);
    }
    for (const field of fields) {
      if (typeof tags[field] !== "string" || (field !== "group" && tags[field].length === 0)) {
        fail(`${metricName} event has invalid ${field}`);
      }
    }
    const status = Number(tags.status);
    if (!Number.isInteger(status)) fail(`${metricName} event has invalid status`);
    events.push({ tags, status });
  }
  return events;
}

export function parseSignAttemptEvents(jsonLines) {
  return parseEvents(jsonLines, "sign_attempts", [
    "cohort", "group", "outcome", "phase", "scenario", "signature_id", "slot_key", "status",
  ]).map(({ tags, status }) => ({
    cohort: tags.cohort,
    slotKey: tags.slot_key,
    status,
    signatureId: tags.signature_id,
    outcome: tags.outcome,
  }));
}

export function parseSignSetupEvents(jsonLines) {
  return parseEvents(jsonLines, "sign_setup_attempts", [
    "cohort", "group", "outcome", "slot_key", "status",
  ]).map(({ tags, status }) => ({
    cohort: tags.cohort,
    slotKey: tags.slot_key,
    status,
    outcome: tags.outcome,
  }));
}

export function verifySignAttemptEvents(events) {
  const expected = new Map(SIGN_COHORTS.map(({ name, size }) => [name, size]));
  const attempts = Object.fromEntries(SIGN_COHORTS.map(({ name }) => [name, 0]));
  const slots = new Set();
  const signatures = new Set();
  for (const event of events) {
    if (!expected.has(event.cohort)) fail(`unknown attempt cohort ${event.cohort}`);
    attempts[event.cohort] += 1;
    if (slots.has(event.slotKey)) fail(`duplicate attempt slot ${event.slotKey}`);
    slots.add(event.slotKey);
    if (event.status !== 201 || event.outcome !== "created") {
      fail(`attempt ${event.slotKey} outcome ${event.outcome} returned HTTP ${event.status}`);
    }
    if (event.signatureId === "missing") fail(`attempt ${event.slotKey} has no signature ID`);
    if (signatures.has(event.signatureId)) fail(`duplicate signature ID ${event.signatureId}`);
    signatures.add(event.signatureId);
  }
  for (const [cohort, size] of expected) {
    if (attempts[cohort] !== size) fail(`cohort ${cohort} recorded ${attempts[cohort]}, expected ${size}`);
  }
  return {
    attempts,
    created: signatures.size,
    uniqueSlots: slots.size,
    uniqueSignatures: signatures.size,
    errors: 0,
    serverErrors: 0,
  };
}

function metric(summary, name) {
  const value = summary.metrics?.[name];
  if (!value || typeof value !== "object") fail(`summary is missing metric ${name}`);
  return value;
}

function requireValue(summary, name, field, expected) {
  const actual = metric(summary, name).values?.[field];
  if (actual !== expected) fail(`metric ${name} ${field} was ${actual}, expected ${expected}`);
}

function requireThreshold(summary, metricName, thresholdName) {
  if (metric(summary, metricName).thresholds?.[thresholdName]?.ok !== true) {
    fail(`metric ${metricName} failed threshold ${thresholdName}`);
  }
}

export function verifySignSummary(summary) {
  const latencyMs = {};
  for (const { name, size } of SIGN_COHORTS) {
    const metrics = {
      setup: `http_reqs{phase:sign_setup,cohort:${name}}`,
      setupFailed: `http_req_failed{phase:sign_setup,cohort:${name}}`,
      setupAttempts: `sign_setup_attempts{cohort:${name}}`,
      setupErrors: `sign_setup_errors{cohort:${name}}`,
      attempts: `sign_attempts{cohort:${name}}`,
      created: `sign_created{cohort:${name}}`,
      errors: `sign_errors{cohort:${name}}`,
      serverErrors: `sign_5xx{cohort:${name}}`,
      duration: `sign_duration{cohort:${name}}`,
    };
    requireValue(summary, metrics.setup, "count", size);
    requireValue(summary, metrics.setupFailed, "rate", 0);
    requireValue(summary, metrics.setupAttempts, "count", size);
    requireValue(summary, metrics.setupErrors, "rate", 0);
    requireValue(summary, metrics.attempts, "count", size);
    requireValue(summary, metrics.created, "count", size);
    requireValue(summary, metrics.errors, "rate", 0);
    requireValue(summary, metrics.serverErrors, "rate", 0);
    requireThreshold(summary, metrics.duration, "p(95)<2000");
    requireThreshold(summary, metrics.duration, "p(99)<5000");
    for (const metricName of Object.values(metrics)) {
      const thresholds = metric(summary, metricName).thresholds;
      if (!thresholds || Object.values(thresholds).some((result) => result?.ok !== true)) {
        fail(`metric ${metricName} has a failed or missing threshold`);
      }
    }
    const duration = metric(summary, metrics.duration).values;
    if (!Number.isFinite(duration["p(95)"])) fail(`metric ${metrics.duration} p(95) must be finite`);
    if (!Number.isFinite(duration["p(99)"])) fail(`metric ${metrics.duration} p(99) must be finite`);
    if (duration["p(95)"] >= 2_000) fail(`metric ${metrics.duration} failed threshold p(95)<2000`);
    if (duration["p(99)"] >= 5_000) fail(`metric ${metrics.duration} failed threshold p(99)<5000`);
    latencyMs[name] = { p95: duration["p(95)"], p99: duration["p(99)"] };
  }
  return { setup: 185, latencyMs };
}

export function verifySignArtifacts(jsonLines, summary) {
  const setupEvents = parseSignSetupEvents(jsonLines);
  const attemptEvents = parseSignAttemptEvents(jsonLines);
  const setupCohortByKey = new Map();
  const setupCounts = Object.fromEntries(SIGN_COHORTS.map(({ name }) => [name, 0]));
  for (const event of setupEvents) {
    if (!(event.cohort in setupCounts)) fail(`unknown setup cohort ${event.cohort}`);
    if (event.status !== 200 || event.outcome !== "authenticated") {
      fail(`setup ${event.slotKey} outcome ${event.outcome} returned HTTP ${event.status}`);
    }
    if (setupCohortByKey.has(event.slotKey)) fail(`duplicate setup slot ${event.slotKey}`);
    setupCohortByKey.set(event.slotKey, event.cohort);
    setupCounts[event.cohort] += 1;
  }
  for (const { name, size } of SIGN_COHORTS) {
    if (setupCounts[name] !== size) fail(`setup cohort ${name} recorded ${setupCounts[name]}, expected ${size}`);
  }
  const attempts = verifySignAttemptEvents(attemptEvents);
  for (const event of attemptEvents) {
    const setupCohort = setupCohortByKey.get(event.slotKey);
    if (!setupCohort) fail(`attempt slot ${event.slotKey} was not authenticated in setup`);
    if (setupCohort !== event.cohort) {
      fail(`attempt slot ${event.slotKey} had setup cohort ${setupCohort} but sign cohort ${event.cohort}`);
    }
  }
  return { setupEvents: setupEvents.length, ...attempts, ...verifySignSummary(summary) };
}
