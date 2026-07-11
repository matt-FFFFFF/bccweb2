#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { existsSync, readFileSync } from "node:fs";
import { assertLoadTestTarget } from "./lib/loadTestRuntimeGuard.mjs";

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

function adminPassword(path) {
  const override = process.env.ADMIN_PASSWORD;
  if (override) return override;
  if (existsSync(path)) {
    const match = readFileSync(path, "utf8").match(/^ADMIN_PASSWORD=(.+)$/m);
    if (match?.[1]) return match[1].trim();
  }
  fail("missing admin password; set ADMIN_PASSWORD or create .dev-credentials; state preserved");
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
  const baseUrl = process.env.BCC_API_BASE_URL ?? "http://localhost:7071";
  const dedicatedStack = process.env.LOADTEST_DEDICATED_STACK === "1";
  assertLoadTestTarget(baseUrl, dedicatedStack);
  if (!dedicatedStack) {
    fail("dedicated stack confirmation LOADTEST_DEDICATED_STACK=1 is required before verification");
  }
  const [
    { ADMIN_EMAIL, DEV_CREDENTIALS_PATH, PREPARED_ROUND_PATH },
    { createReflectQueueReader, waitForReflectQueues },
    { parseRawVerificationArtifacts },
    { runSignVerification },
    { createVerifierApi },
  ] = await Promise.all([
    import("./lib/loadTestConsts.mjs"),
    import("./lib/loadTestReflectQueues.mjs"),
    import("./lib/loadTestSignVerificationArtifacts.mjs"),
    import("./lib/loadTestSignVerificationRunner.mjs"),
    import("./lib/loadTestVerifierApi.mjs"),
  ]);
  const { eventsPath, summaryPath } = artifactPaths();
  const prepared = readJson(PREPARED_ROUND_PATH, "prepared round artifact");
  const summary = readJson(summaryPath, "sign summary artifact");
  const jsonLines = readText(eventsPath, "sign events artifact");
  const parsed = parseRawVerificationArtifacts(prepared, jsonLines, summary);
  if (prepared.baseUrl !== baseUrl) {
    fail("prepared artifact baseUrl does not match BCC_API_BASE_URL; state preserved");
  }
  const deadlineMs = Date.now() + VERIFY_DEADLINE_MS;
  const callApi = createVerifierApi({ baseUrl, deadlineMs });
  const login = async (email, password) => {
    const json = await requireStatus(callApi, "POST", "/api/auth/login", {
      body: { email, password },
    }, 200);
    if (typeof json?.accessToken !== "string" || json.accessToken.length === 0) {
      fail("login response missing accessToken; state preserved");
    }
    return json.accessToken;
  };
  const adminToken = await login(ADMIN_EMAIL, adminPassword(DEV_CREDENTIALS_PATH));
  const readCounts = createReflectQueueReader({ environment: process.env });
  const report = await runSignVerification({
    prepared,
    parsed,
    dedicatedStack,
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
