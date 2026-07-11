#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { existsSync, readFileSync } from "node:fs";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD_OVERRIDE,
  BCC_API_BASE_URL,
  DEV_CREDENTIALS_PATH,
  PREPARED_ROUND_PATH,
} from "./lib/loadTestConsts.mjs";
import { createReflectQueueReader, waitForReflectQueues } from "./lib/loadTestReflectQueues.mjs";
import { runSignVerification } from "./lib/loadTestSignVerificationRunner.mjs";
import { createVerifierApi } from "./lib/loadTestVerifierApi.mjs";

const VERIFY_DEADLINE_MS = 5 * 60 * 1_000;
const FLAG_TIMEOUT_MS = 2 * 60 * 1_000;
const QUEUE_TIMEOUT_MS = 2 * 60 * 1_000;
const POLL_INTERVAL_MS = 2_000;

function fail(message) {
  throw new Error(`[verify-loadtest-signtofly] ${message}`);
}

function readJson(path, label) {
  if (!existsSync(path)) fail(`missing ${label} at ${path}; state preserved`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    fail(`${label} is not valid JSON; state preserved`, { cause });
  }
}

function readText(path, label) {
  if (!existsSync(path)) fail(`missing ${label} at ${path}; state preserved`);
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    fail(`${label} could not be read; state preserved`, { cause });
  }
}

function adminPassword() {
  if (ADMIN_PASSWORD_OVERRIDE) return ADMIN_PASSWORD_OVERRIDE;
  if (existsSync(DEV_CREDENTIALS_PATH)) {
    const match = readFileSync(DEV_CREDENTIALS_PATH, "utf8").match(/^ADMIN_PASSWORD=(.+)$/m);
    if (match?.[1]) return match[1].trim();
  }
  fail("missing admin password; set ADMIN_PASSWORD or create .dev-credentials; state preserved");
}

function assertSafeTarget() {
  const host = new URL(BCC_API_BASE_URL).hostname.toLowerCase();
  if (/(^|[.-])prod([.-]|$)/u.test(host) || host.includes("production")) {
    fail("refusing to run against a production-looking target; state preserved");
  }
}

function artifactPaths() {
  const [eventsArg, summaryArg] = process.argv.slice(2);
  const eventsPath = eventsArg ?? process.env.SIGN_EVENTS_PATH;
  const summaryPath = summaryArg ?? process.env.SIGN_SUMMARY_PATH;
  if (!eventsPath || !summaryPath) {
    fail("usage: verify-loadtest-signtofly.mjs <sign-events.json> <sign-summary.json>; state preserved");
  }
  return { eventsPath, summaryPath };
}

async function requireStatus(callApi, method, path, request, expectedStatus) {
  const response = await callApi(method, path, request);
  if (response.status !== expectedStatus) {
    fail(`${method} ${path} expected HTTP ${expectedStatus}, got ${response.status}; state preserved`);
  }
  return response.json;
}

async function main() {
  assertSafeTarget();
  const { eventsPath, summaryPath } = artifactPaths();
  const prepared = readJson(PREPARED_ROUND_PATH, "prepared round artifact");
  const summary = readJson(summaryPath, "sign summary artifact");
  if (prepared.baseUrl !== BCC_API_BASE_URL) {
    fail("prepared artifact baseUrl does not match BCC_API_BASE_URL; state preserved");
  }
  const deadlineMs = Date.now() + VERIFY_DEADLINE_MS;
  const callApi = createVerifierApi({ baseUrl: BCC_API_BASE_URL, deadlineMs });
  const login = async (email, password) => {
    const json = await requireStatus(callApi, "POST", "/api/auth/login", {
      body: { email, password },
    }, 200);
    if (typeof json?.accessToken !== "string" || json.accessToken.length === 0) {
      fail("login response missing accessToken; state preserved");
    }
    return json.accessToken;
  };
  const adminToken = await login(ADMIN_EMAIL, adminPassword());
  const readCounts = createReflectQueueReader({ environment: process.env });
  const report = await runSignVerification({
    prepared,
    jsonLines: readText(eventsPath, "sign events artifact"),
    summary,
    dedicatedStack: process.env.LOADTEST_DEDICATED_STACK === "1",
    login,
    getSignatures: (roundId) => requireStatus(
      callApi, "GET", `/api/rounds/${encodeURIComponent(roundId)}/signatures`, { token: adminToken }, 200,
    ),
    loadRound: (roundId) => requireStatus(
      callApi, "GET", `/api/rounds/${encodeURIComponent(roundId)}`, { token: adminToken }, 200,
    ),
    postReplay: async (roundId, target, token) => {
      const response = await callApi(
        "POST", `/api/rounds/${encodeURIComponent(roundId)}/teams/${encodeURIComponent(target.teamId)}/pilots/${encodeURIComponent(target.place)}/sign`, { token },
      );
      return { status: response.status, id: response.json?.id };
    },
    flagPolling: {
      deadlineMs: FLAG_TIMEOUT_MS,
      intervalMs: POLL_INTERVAL_MS,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    waitForQueues: () => waitForReflectQueues({
      readCounts,
      deadlineMs: QUEUE_TIMEOUT_MS,
      intervalMs: POLL_INTERVAL_MS,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
  });
  console.error(`[verify-loadtest-signtofly] OK: ${report.output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
