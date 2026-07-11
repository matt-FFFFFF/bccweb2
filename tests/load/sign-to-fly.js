// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import exec from "k6/execution";

// init context — only place where open() can be used.
const PREPARED = JSON.parse(open("./.prepared-round.json"));
const PHASE = (__ENV.PHASE || "register").toLowerCase();
if (PHASE !== "register") {
  throw new Error("sign phase moved to sign-phase.js");
}

const PILOT_COUNT = 500;
const LOGIN_BATCH_SIZE = 25;
const REGISTER_COHORT_SIZE = 25;
const REGISTER_COHORT_INTERVAL_SECONDS = 5;
const SETUP_REQUESTS_METRIC = "http_reqs{phase:setup,operation:register-login}";
const SETUP_TOKEN_METRIC = "checks{phase:setup,operation:register-login-token}";
const REGISTER_DURATION_METRIC = "http_req_duration{phase:register,operation:register-self}";
const registerAttempts = new Counter("register_attempts");
const registerSuccesses = new Counter("register_successes");
const registerFailures = new Counter("register_failures");
const register5xx = new Counter("register_5xx");
const REGISTER_SCENARIOS = {};
for (let start = 0; start < PILOT_COUNT; start += REGISTER_COHORT_SIZE) {
  REGISTER_SCENARIOS[`register_${start}`] = {
    executor: "per-vu-iterations",
    vus: REGISTER_COHORT_SIZE,
    iterations: 1,
    startTime: `${(start / REGISTER_COHORT_SIZE) * REGISTER_COHORT_INTERVAL_SECONDS}s`,
    maxDuration: "15m",
    env: { REGISTER_OFFSET: String(start) },
  };
}

const REGISTER_OPTIONS = {
  setupTimeout: "10m",
  scenarios: REGISTER_SCENARIOS,
  thresholds: {
    [SETUP_REQUESTS_METRIC]: ["count==500"],
    "http_req_failed{phase:setup,operation:register-login}": ["rate==0"],
    [SETUP_TOKEN_METRIC]: ["rate==1"],
    register_attempts: ["count==500"],
    register_successes: ["count==500"],
    register_failures: ["count==0"],
    register_5xx: ["count==0"],
    [REGISTER_DURATION_METRIC]: ["max<900000"],
  },
};

export const options = REGISTER_OPTIONS;

export function setup() {
  if (!Array.isArray(PREPARED.teams) || PREPARED.teams.length !== PILOT_COUNT) {
    throw new Error(`register setup requires exactly ${PILOT_COUNT} prepared pilots`);
  }

  const responses = [];
  for (let start = 0; start < PILOT_COUNT; start += LOGIN_BATCH_SIZE) {
    const requests = PREPARED.teams.slice(start, start + LOGIN_BATCH_SIZE).map((slot, offset) => {
      if (
        typeof slot.pilotEmail !== "string" ||
        typeof slot.pilotPassword !== "string" ||
        typeof slot.teamId !== "string"
      ) {
        throw new Error(`invalid prepared pilot at index ${start + offset}`);
      }
      return {
        method: "POST",
        url: `${PREPARED.baseUrl}/api/auth/login`,
        body: JSON.stringify({ email: slot.pilotEmail, password: slot.pilotPassword }),
        params: {
          headers: {
            "Content-Type": "application/json",
            // Local Functions uses the right-most XFF hop when `client-ip` is absent.
            // Azure supplies trusted `client-ip`, so this value cannot partition remote traffic.
            "X-Forwarded-For": localSourceIp(start + offset),
          },
          tags: { phase: "setup", operation: "register-login" },
          timeout: "30s",
        },
      };
    });
    responses.push(...http.batch(requests));
  }

  const tokens = [];
  let invalidLogins = 0;
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    const token = accessToken(response);
    const validToken = typeof token === "string" && token.length > 0;
    check(token, { "register login token": () => validToken }, {
      phase: "setup",
      operation: "register-login-token",
    });
    if (response.status !== 200 || !validToken) {
      invalidLogins += 1;
    }
    tokens.push(token);
  }
  if (invalidLogins > 0) {
    throw new Error(`register setup rejected ${invalidLogins} of ${PILOT_COUNT} logins`);
  }

  return { ...PREPARED, tokens };
}

function accessToken(res) {
  try {
    return res.json("accessToken");
  } catch (_) {
    return null;
  }
}

function localSourceIp(zeroBased) {
  return `10.15.${Math.floor(zeroBased / 250)}.${(zeroBased % 250) + 1}`;
}

export default function (data) {
  const idx = Number(__ENV.REGISTER_OFFSET) + exec.scenario.iterationInTest;
  const slot = data.teams[idx];
  const token = data.tokens[idx];

  registerAttempts.add(1, { phase: "register", operation: "register-self" });
  const response = http.post(
    `${data.baseUrl}/api/rounds/${data.roundId}/register-self`,
    JSON.stringify({ teamId: slot.teamId }),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Forwarded-For": localSourceIp(idx),
      },
      timeout: "15m",
      tags: { phase: "register", operation: "register-self" },
    },
  );
  const success = response.status === 200;
  registerSuccesses.add(success ? 1 : 0, { phase: "register", operation: "register-self" });
  registerFailures.add(success ? 0 : 1, { phase: "register", operation: "register-self" });
  register5xx.add(response.status >= 500 ? 1 : 0, { phase: "register", operation: "register-self" });
  check(response, { "register 200": () => success });
}

export function handleSummary(data) {
  const summary = {
    setupLoginRequests: metricValue(data, SETUP_REQUESTS_METRIC, "count"),
    setupLoginTokens: metricValue(data, SETUP_TOKEN_METRIC, "passes"),
    registerAttempts: metricValue(data, "register_attempts", "count"),
    registerSuccesses: metricValue(data, "register_successes", "count"),
    registerFailures: metricValue(data, "register_failures", "count"),
    register5xx: metricValue(data, "register_5xx", "count"),
    registerLatencyMs: {
      average: metricValue(data, REGISTER_DURATION_METRIC, "avg"),
      p95: metricValue(data, REGISTER_DURATION_METRIC, "p(95)"),
      maximum: metricValue(data, REGISTER_DURATION_METRIC, "max"),
    },
  };
  const output = `${JSON.stringify(summary, null, 2)}\n`;
  return __ENV.REGISTER_SUMMARY_PATH
    ? { stdout: output, [__ENV.REGISTER_SUMMARY_PATH]: output }
    : { stdout: output };
}

function metricValue(data, metricName, valueName) {
  return data.metrics[metricName]?.values[valueName] ?? 0;
}
