// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runRegisterContract } from "./register-contract-runtime.mjs";

const SCRIPT_URL = new URL("./sign-to-fly.js", import.meta.url);
const SCRIPT_SOURCE = await readFile(SCRIPT_URL, "utf8");
const FAST_SCRIPT_SOURCE = SCRIPT_SOURCE.replace(
  "const REGISTER_COHORT_INTERVAL_SECONDS = 5;",
  "const REGISTER_COHORT_INTERVAL_SECONDS = 0;",
);
const PILOT_COUNT = 500;

test("register source has exact one-shot setup and VU gates", () => {
  // Given the register k6 source
  // When its static contract is inspected
  // Then setup and VU traffic have exact counts and no retry surface
  assert.match(SCRIPT_SOURCE, /setupTimeout:\s*"10m"/);
  assert.match(SCRIPT_SOURCE, /LOGIN_BATCH_SIZE\s*=\s*25/);
  assert.match(SCRIPT_SOURCE, /REGISTER_COHORT_SIZE\s*=\s*25/);
  assert.match(SCRIPT_SOURCE, /REGISTER_COHORT_INTERVAL_SECONDS\s*=\s*5/);
  assert.match(SCRIPT_SOURCE, /timeout:\s*"30s"/);
  assert.match(SCRIPT_SOURCE, /phase:\s*"setup"/);
  assert.match(SCRIPT_SOURCE, /operation:\s*"register-login"/);
  assert.match(SCRIPT_SOURCE, /http_reqs\{phase:setup,operation:register-login\}/);
  assert.match(SCRIPT_SOURCE, /http_req_failed\{phase:setup,operation:register-login\}/);
  assert.match(SCRIPT_SOURCE, /register_attempts:\s*\["count==500"\]/);
  assert.match(SCRIPT_SOURCE, /register_successes:\s*\["count==500"\]/);
  assert.match(SCRIPT_SOURCE, /register_failures:\s*\["count==0"\]/);
  assert.match(SCRIPT_SOURCE, /register_5xx:\s*\["count==0"\]/);
  assert.doesNotMatch(SCRIPT_SOURCE, /\bretry\w*\b/i);
  assert.doesNotMatch(SCRIPT_SOURCE, /\bsleep\s*\(/);
  assert.doesNotMatch(SCRIPT_SOURCE, /preferredPlace/);
});

test("register executes 500 setup logins and 500 single POSTs", async () => {
  // Given 500 valid prepared pilots and a successful API
  const fixture = await makeFixture();
  try {
    // When the actual register source runs in the contract runtime
    const result = await runRegisterSource(fixture);
    // Then every login and registration occurs exactly once
    assert.equal(result.code, 0, result.output);
    assert.equal(fixture.state.loginRequests, PILOT_COUNT);
    assert.equal(fixture.state.registerRequests, PILOT_COUNT);
    const summary = JSON.parse(await readFile(fixture.summaryPath, "utf8"));
    assert.deepEqual({
      setupLoginRequests: summary.setupLoginRequests,
      setupLoginTokens: summary.setupLoginTokens,
      registerAttempts: summary.registerAttempts,
      registerSuccesses: summary.registerSuccesses,
      registerFailures: summary.registerFailures,
      register5xx: summary.register5xx,
    }, {
      setupLoginRequests: 500,
      setupLoginTokens: 500,
      registerAttempts: 500,
      registerSuccesses: 500,
      registerFailures: 0,
      register5xx: 0,
    });
    assert.equal(typeof summary.registerLatencyMs.p95, "number");
  } finally {
    await fixture.close();
  }
});

test("bad credential aborts setup without retrying or registering", async () => {
  // Given one invalid credential among 500 prepared pilots
  const fixture = await makeFixture({ badPilot: 217 });
  try {
    // When the actual register source runs in the contract runtime
    const result = await runRegisterSource(fixture);
    // Then setup fails after one login per pilot and no VU starts
    assert.notEqual(result.code, 0, result.output);
    assert.equal(fixture.state.loginRequests, PILOT_COUNT);
    assert.equal(fixture.state.failedLogins, 1);
    assert.equal(fixture.state.registerRequests, 0);
  } finally {
    await fixture.close();
  }
});

test("missing token aborts setup without retrying or registering", async () => {
  // Given one successful login response without an access token
  const fixture = await makeFixture({ missingTokenPilot: 311 });
  try {
    // When the actual register source runs in the contract runtime
    const result = await runRegisterSource(fixture);
    // Then every login is issued once and no registration starts
    assert.notEqual(result.code, 0, result.output);
    assert.equal(fixture.state.loginRequests, PILOT_COUNT);
    assert.equal(fixture.state.registerRequests, 0);
  } finally {
    await fixture.close();
  }
});

test("bad prepared count aborts before login or registration", async () => {
  // Given only 499 prepared pilots
  const fixture = await makeFixture({ pilotCount: PILOT_COUNT - 1 });
  try {
    // When the actual register source runs in the contract runtime
    const result = await runRegisterSource(fixture);
    // Then setup rejects the artifact without issuing traffic
    assert.notEqual(result.code, 0, result.output);
    assert.equal(fixture.state.loginRequests, 0);
    assert.equal(fixture.state.registerRequests, 0);
  } finally {
    await fixture.close();
  }
});

for (const status of [409, 500]) {
  test(`register ${status} is attempted once and fails the run`, async () => {
    // Given a server that rejects one registration with the selected status
    const fixture = await makeFixture({ registerFailureStatus: status });
    try {
      // When the actual register source runs in the contract runtime
      const result = await runRegisterSource(fixture);
      // Then all VUs send one request and exact failure gates make k6 nonzero
      assert.notEqual(result.code, 0, result.output);
      assert.equal(fixture.state.loginRequests, PILOT_COUNT);
      assert.equal(fixture.state.registerRequests, PILOT_COUNT);
      assert.equal(fixture.state.rejectedRegistrations, 1);
    } finally {
      await fixture.close();
    }
  });
}

test("setup timeout starts no register VUs", async () => {
  // Given login responses that exceed an injected short setup timeout
  const fixture = await makeFixture({ loginDelayMs: 500 });
  try {
    // When supported k6 configuration overrides the production 10m timeout
    const result = await runRegisterSource(fixture, { K6_SETUP_TIMEOUT: "100ms" });
    // Then setup reaches its deadline and no register request is issued
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /setup\(\) execution timed out|context deadline exceeded/);
    assert.doesNotMatch(result.output, /unknown flag/);
    assert.equal(fixture.state.registerRequests, 0);
  } finally {
    await fixture.close();
  }
});

async function makeFixture({
  badPilot = -1,
  loginDelayMs = 0,
  missingTokenPilot = -1,
  pilotCount = PILOT_COUNT,
  registerFailureStatus = 0,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bcc-register-contract-"));
  const state = {
    loginRequests: 0,
    failedLogins: 0,
    registerRequests: 0,
    rejectedRegistrations: 0,
    registeredTeams: new Set(),
  };
  const teams = Array.from({ length: pilotCount }, (_, index) => ({
    pilotEmail: `pilot${String(index).padStart(3, "0")}@bcc.local`,
    pilotPassword: "fixture-password",
    teamId: `team-${Math.floor(index / 10)}`,
    place: (index % 10) + 1,
  }));
  return {
    directory,
    state,
    prepared: { baseUrl: "http://loadtest.invalid", roundId: "round", teams },
    behavior: { badPilot, loginDelayMs, missingTokenPilot, registerFailureStatus },
    summaryPath: join(directory, "summary.json"),
    close: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function runRegisterSource(fixture, extraEnv = {}) {
  return runRegisterContract({
    source: FAST_SCRIPT_SOURCE,
    prepared: fixture.prepared,
    behavior: fixture.behavior,
    state: fixture.state,
    summaryPath: fixture.summaryPath,
    extraEnv,
  });
}
