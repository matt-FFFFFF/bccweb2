// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import http from "k6/http";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";
import {
  SIGN_COHORTS,
  buildSignOptions,
  buildSignSummary,
  selectSignTargets,
} from "../../scripts/lib/loadTestSign.mjs";

const PREPARED = JSON.parse(open("./.prepared-round.json"));
const SUMMARY_PATH = __ENV.SIGN_SUMMARY_PATH;
const EVENTS_PATH = __ENV.SIGN_EVENTS_PATH;
if (!SUMMARY_PATH || !EVENTS_PATH) {
  throw new Error("SIGN_SUMMARY_PATH and SIGN_EVENTS_PATH are required");
}

const signAttempts = new Counter("sign_attempts");
const signCreated = new Counter("sign_created");
const signErrors = new Rate("sign_errors");
const sign5xx = new Rate("sign_5xx");
const signDuration = new Trend("sign_duration", true);
const signSetupAttempts = new Counter("sign_setup_attempts");
const signSetupErrors = new Rate("sign_setup_errors");

export const options = buildSignOptions();

function sourceIp(preparedIndex) {
  return `10.16.${Math.floor(preparedIndex / 250)}.${(preparedIndex % 250) + 1}`;
}

function accessToken(response) {
  try {
    const token = response.json("accessToken");
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

function signatureId(response) {
  try {
    const id = response.json("id");
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

function loginRequest(target) {
  return {
    method: "POST",
    url: `${PREPARED.baseUrl}/api/auth/login`,
    body: JSON.stringify({ email: target.pilotEmail, password: target.pilotPassword }),
    params: {
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": sourceIp(target.preparedIndex),
      },
      tags: { name: "sign_setup_login", phase: "sign_setup", cohort: target.cohort },
      timeout: "30s",
    },
  };
}

export function setup() {
  const targets = selectSignTargets(PREPARED);
  const authenticated = [];
  const tokens = new Set();
  const failures = [];
  for (let offset = 0; offset < targets.length; offset += 25) {
    const batch = targets.slice(offset, offset + 25);
    const responses = http.batch(batch.map(loginRequest));
    for (let index = 0; index < responses.length; index += 1) {
      const target = batch[index];
      const response = responses[index];
      const token = accessToken(response);
      const duplicateToken = token !== null && tokens.has(token);
      const authenticatedTarget = response.status === 200 && token !== null && !duplicateToken;
      const tags = {
        cohort: target.cohort,
        slot_key: target.slotKey,
        status: String(response.status),
        outcome: authenticatedTarget ? "authenticated" : duplicateToken ? "duplicate_token" : "login_error",
      };
      signSetupAttempts.add(1, tags);
      signSetupErrors.add(authenticatedTarget ? 0 : 1, tags);
      if (!authenticatedTarget) {
        failures.push(`${target.slotKey} HTTP ${response.status} ${tags.outcome}`);
        continue;
      }
      tokens.add(token);
      authenticated.push({
        cohort: target.cohort,
        slotKey: target.slotKey,
        teamId: target.teamId,
        place: target.place,
        token,
        sourceIp: sourceIp(target.preparedIndex),
      });
    }
  }
  if (failures.length > 0) {
    throw new Error(`sign setup failed: ${failures.join(", ")}`);
  }
  return { baseUrl: PREPARED.baseUrl, roundId: PREPARED.roundId, targets: authenticated };
}

function cohortForScenario(name) {
  const cohort = SIGN_COHORTS.find((candidate) => `sign_${candidate.name}` === name);
  if (!cohort) throw new Error(`unknown sign scenario ${name}`);
  return cohort;
}

function outcomeFor(response, id) {
  if (response.status === 201 && id) return "created";
  if (response.status === 200) return "stale_replay";
  if (response.status >= 500) return "server_error";
  if (response.status === 0) return "request_error";
  return "http_error";
}

export function signOnce(data) {
  const cohort = cohortForScenario(exec.scenario.name);
  const targetIndex = cohort.offset + exec.scenario.iterationInTest;
  const target = data.targets[targetIndex];
  if (!target || target.cohort !== cohort.name) {
    throw new Error(`missing target ${targetIndex} for cohort ${cohort.name}`);
  }

  const response = http.post(
    `${data.baseUrl}/api/rounds/${data.roundId}/teams/${target.teamId}/pilots/${target.place}/sign`,
    null,
    {
      headers: {
        Authorization: `Bearer ${target.token}`,
        "X-Forwarded-For": target.sourceIp,
      },
      tags: { name: "sign", phase: "sign", cohort: cohort.name },
      timeout: "15s",
    },
  );
  const id = signatureId(response);
  const created = response.status === 201 && id !== null;
  const tags = {
    cohort: cohort.name,
    slot_key: target.slotKey,
    status: String(response.status),
    signature_id: id ?? "missing",
    outcome: outcomeFor(response, id),
  };
  signAttempts.add(1, tags);
  if (created) signCreated.add(1, tags);
  signErrors.add(created ? 0 : 1, tags);
  sign5xx.add(response.status >= 500 ? 1 : 0, tags);
  signDuration.add(response.timings.duration, tags);
}

export function handleSummary(data) {
  return {
    [SUMMARY_PATH]: JSON.stringify(buildSignSummary(data), null, 2),
  };
}
