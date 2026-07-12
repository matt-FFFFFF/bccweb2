// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { writeFile } from "node:fs/promises";

export async function runRegisterContract({
  source,
  prepared,
  behavior,
  state,
  summaryPath,
  extraEnv = {},
}) {
  const env = {
    PHASE: "register",
    REGISTER_SUMMARY_PATH: summaryPath,
    ...extraEnv,
  };
  const metrics = new Map();
  const execution = { scenario: { iterationInTest: 0 } };

  class Counter {
    constructor(name) {
      this.name = name;
    }

    add(value) {
      metrics.set(this.name, (metrics.get(this.name) ?? 0) + value);
    }
  }

  const response = (status, payload) => ({
    status,
    json: (key) => payload[key],
  });
  const login = (request) => {
    state.loginRequests += 1;
    const body = JSON.parse(request.body);
    const pilot = Number.parseInt(body.email.slice(5, 8), 10);
    if (pilot === behavior.badPilot) {
      state.failedLogins += 1;
      return response(401, { error: "invalid" });
    }
    const payload = pilot === behavior.missingTokenPilot
      ? {}
      : { accessToken: `token-${pilot}` };
    return response(200, payload);
  };
  const http = {
    batch: (requests) => {
      if (extraEnv.K6_SETUP_TIMEOUT && behavior.loginDelayMs > 0) {
        throw new Error("setup() execution timed out");
      }
      return requests.map(login);
    },
    post: (_url, body) => {
      state.registerRequests += 1;
      state.registeredTeams.add(JSON.parse(body).teamId);
      if (
        behavior.registerFailureStatus > 0 &&
        state.rejectedRegistrations === 0
      ) {
        state.rejectedRegistrations += 1;
        return response(behavior.registerFailureStatus, {});
      }
      return response(200, { place: state.registerRequests });
    },
  };
  const executableSource = source
    .replace(/^import .*;$/gm, "")
    .replace("export const options", "const options")
    .replace("export function setup", "function setup")
    .replace("export default function (data)", "function register(data)")
    .replace("export function handleSummary", "function handleSummary");
  const load = new Function(
    "http",
    "check",
    "Counter",
    "exec",
    "open",
    "__ENV",
    `${executableSource}\nreturn { setup, register, handleSummary };`,
  );
  const module = load(
    http,
    (_value, checks) => Object.values(checks).every((check) => check()),
    Counter,
    execution,
    () => JSON.stringify(prepared),
    env,
  );

  try {
    const data = module.setup();
    for (let offset = 0; offset < 500; offset += 25) {
      env.REGISTER_OFFSET = String(offset);
      for (let iteration = 0; iteration < 25; iteration += 1) {
        execution.scenario.iterationInTest = iteration;
        module.register(data);
      }
    }
    const summary = module.handleSummary(summaryData(state, metrics));
    await writeFile(summaryPath, summary[summaryPath]);
    return {
      code: (metrics.get("register_failures") ?? 0) > 0 ? 99 : 0,
      output: summary.stdout,
    };
  } catch (error) {
    return {
      code: 107,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

function summaryData(state, metrics) {
  return { metrics: {
    "http_reqs{phase:setup,operation:register-login}": {
      values: { count: state.loginRequests },
    },
    "checks{phase:setup,operation:register-login-token}": {
      values: { passes: state.loginRequests - state.failedLogins },
    },
    register_attempts: { values: { count: metrics.get("register_attempts") ?? 0 } },
    register_successes: { values: { count: metrics.get("register_successes") ?? 0 } },
    register_failures: { values: { count: metrics.get("register_failures") ?? 0 } },
    register_5xx: { values: { count: metrics.get("register_5xx") ?? 0 } },
    "http_req_duration{phase:register,operation:register-self}": {
      values: { avg: 0, "p(95)": 0, max: 0 },
    },
  } };
}
