import http from "k6/http";
import { check, fail, sleep } from "k6";

// init context — only place where open() can be used.
const PREPARED = JSON.parse(open("./.prepared-round.json"));
const PHASE = (__ENV.PHASE || "register").toLowerCase();
if (PHASE !== "register" && PHASE !== "sign") {
  throw new Error("PHASE must be register or sign");
}

export const options = {
  scenarios: {
    loadtest: {
      executor: "per-vu-iterations",
      vus: 500,
      iterations: 1,
      maxDuration: "15m",
    },
  },
  // NO thresholds — k6 thresholds gate exit code; stdout summary is advisory.
};

export function setup() {
  return PREPARED;
}

function retryDelay() {
  // The plan forbids success-path sleep because this test must maintain maximum
  // contention pressure. This sleep is only conflict backoff after HTTP 500s
  // from the round-blob lease bottleneck, so successful requests are unthrottled.
  sleep(0.1 + Math.random() * 0.3);
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
      retryDelay();
    }
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

  const loginRes = http.post(
    `${data.baseUrl}/api/auth/login`,
    JSON.stringify({ email: slot.pilotEmail, password: slot.pilotPassword }),
    {
      headers: { "Content-Type": "application/json", "X-Forwarded-For": sourceIp },
      tags: { name: "login" },
      timeout: "15m",
    },
  );
  check(loginRes, { "login 200": (r) => r.status === 200 });
  const token = loginRes.json("accessToken");
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
    const result = postWithLeaseRetry(
      `${data.baseUrl}/api/rounds/${data.roundId}/teams/${slot.teamId}/pilots/${slot.place}/sign`,
      null,
      { ...auth, tags: { name: "phase", phase: "sign" } },
    );
    if (result.retries > 0) {
      console.log(`retry phase=sign vu=${__VU} retries=${result.retries} status=${result.res.status}`);
    }
    check(result.res, {
      "sign 200": (r) => r.status === 200,
    });
  }
}
