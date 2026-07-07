import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter } from "k6/metrics";
import exec from "k6/execution";

// init context — only place where open() can be used.
const PREPARED = JSON.parse(open("./.prepared-round.json"));
const PHASE = (__ENV.PHASE || "register").toLowerCase();
if (PHASE !== "register" && PHASE !== "sign") {
  throw new Error("PHASE must be register or sign");
}

// Counts sign responses with status >= 500. The sign path deliberately does NOT
// mask 5xx (no lease-retry), so any unexpected server error lands here and —
// via the `sign_5xx: count==0` threshold below — fails the whole run.
const sign5xx = new Counter("sign_5xx");

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

// SIGN: ramp concurrency 10 → 25 → 50 → 100 on the SAME prepared round and gate
// HARD on server errors. A single sign 5xx (or >1% sign-phase HTTP failure)
// fails the run — this is the gate that catches the sign-path concurrency bug.
const SIGN_OPTIONS = {
  scenarios: {
    sign: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5s", target: 10 },
        { duration: "30s", target: 10 },
        { duration: "5s", target: 25 },
        { duration: "30s", target: 25 },
        { duration: "5s", target: 50 },
        { duration: "30s", target: 50 },
        { duration: "5s", target: 100 },
        { duration: "30s", target: 100 },
      ],
      gracefulStop: "30s",
    },
  },
  thresholds: {
    // Any sign response with status >= 500 fails the run.
    sign_5xx: ["count==0"],
    // Sign-phase HTTP failures (status >= 400) must stay below 1%.
    "http_req_failed{phase:sign}": ["rate<0.01"],
  },
};

export const options = PHASE === "sign" ? SIGN_OPTIONS : REGISTER_OPTIONS;

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
  // REGISTER keeps its per-VU slot mapping unchanged. SIGN ramps VUs (each VU
  // loops), so key the slot off the global iteration counter to give every sign
  // a fresh, not-yet-signed slot — maximising genuine write contention.
  const idx =
    PHASE === "sign"
      ? exec.scenario.iterationInTest % data.teams.length
      : (__VU - 1) % data.teams.length;
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

  if (PHASE === "register") {
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
  } else {
    // SIGN: no lease-retry — a 500 is a real failure, not something to mask.
    // Tagged phase:sign so the http_req_failed{phase:sign} threshold scopes to
    // exactly this request (login stays tagged name:login, excluded from it).
    const res = http.post(
      `${data.baseUrl}/api/rounds/${data.roundId}/teams/${slot.teamId}/pilots/${slot.place}/sign`,
      null,
      { ...auth, tags: { name: "phase", phase: "sign" } },
    );
    if (res.status >= 500) {
      sign5xx.add(1);
    }
    check(res, {
      "sign 200": (r) => r.status === 200,
    });
  }
}
