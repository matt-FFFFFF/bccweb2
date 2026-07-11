// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import http from "k6/http";
import { check, fail, sleep } from "k6";

// init context — only place where open() can be used.
const PREPARED = JSON.parse(open("./.prepared-round.json"));
const PHASE = (__ENV.PHASE || "register").toLowerCase();
if (PHASE !== "register") {
  throw new Error("sign phase moved to sign-phase.js");
}

// REGISTER: unchanged 500-VU flood. Advisory only — NO thresholds (k6
// thresholds gate the exit code; the stdout summary stays informational).
const REGISTER_OPTIONS = {
  scenarios: {
    loadtest: {
      executor: "per-vu-iterations",
      vus: 500,
      iterations: 1,
      maxDuration: "15m",
    },
  },
};

export const options = REGISTER_OPTIONS;

export function setup() {
  return PREPARED;
}

function retryDelay(attempt) {
  // The plan forbids success-path sleep because this test must maintain maximum
  // contention pressure. This sleep is only transient-failure backoff, so
  // successful requests are unthrottled.
  sleep((50 * 2 ** attempt + Math.random() * 120000) / 1000);
}

function postWithLeaseRetry(url, body, params) {
  var res = null;
  var retries = 0;

  for (var attempt = 0; attempt < 5; attempt++) {
    res = http.post(url, body, params);
    if (res.status !== 500) {
      return { res: res, retries: retries };
    }
    retries += 1;
    if (attempt < 4) {
      retryDelay(attempt);
    }
  }

  return { res: res, retries: retries };
}

function accessToken(res) {
  try {
    return res.json("accessToken");
  } catch (_) {
    return null;
  }
}

function loginWithRetry(slot, sourceIp) {
  var res = null;
  var retries = 0;

  for (var attempt = 0; attempt < 5; attempt++) {
    res = http.post(
      `${PREPARED.baseUrl}/api/auth/login`,
      JSON.stringify({ email: slot.pilotEmail, password: slot.pilotPassword }),
      {
        headers: { "Content-Type": "application/json", "X-Forwarded-For": sourceIp },
        tags: { name: "login" },
        timeout: "15m",
      },
    );
    if (res.status === 200 && accessToken(res)) {
      return { res: res, retries: retries };
    }
    retries += 1;
    if (attempt < 4 && (res.status === 429 || res.status >= 500 || !accessToken(res))) {
      retryDelay(attempt);
      continue;
    }
    return { res: res, retries: retries };
  }

  return { res: res, retries: retries };
}

function vuSourceIp() {
  const zeroBased = __VU - 1;
  return `10.15.${Math.floor(zeroBased / 250)}.${(zeroBased % 250) + 1}`;
}

export default function (data) {
  const idx = (__VU - 1) % data.teams.length;
  const slot = data.teams[idx];
  const sourceIp = vuSourceIp();

  const loginResult = loginWithRetry(slot, sourceIp);
  if (loginResult.retries > 0) {
    console.log(`retry phase=login vu=${__VU} retries=${loginResult.retries} status=${loginResult.res.status}`);
  }
  const loginRes = loginResult.res;
  check(loginRes, { "login 200": (r) => r.status === 200 });
  const token = accessToken(loginRes);
  if (!token) {
    fail("no token");
  }

  const auth = {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Forwarded-For": sourceIp,
    },
    timeout: "15m",
  };

  const result = postWithLeaseRetry(
    `${data.baseUrl}/api/rounds/${data.roundId}/register-self`,
    JSON.stringify({ teamId: slot.teamId, preferredPlace: slot.place }),
    { ...auth, tags: { name: "phase", phase: "register" } },
  );
  if (result.retries > 0) {
    console.log(`retry phase=register vu=${__VU} retries=${result.retries} status=${result.res.status}`);
  }
  check(result.res, {
    "register ok": (r) => r.status === 200 || r.status === 201,
  });
}
