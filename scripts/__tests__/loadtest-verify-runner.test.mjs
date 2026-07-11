// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createVerifierApi } from "../lib/loadTestVerifierApi.mjs";
import { runSignVerification } from "../lib/loadTestSignVerificationRunner.mjs";
import { parseRawVerificationArtifacts } from "../lib/loadTestSignVerificationArtifacts.mjs";
import { artifactFixture, preparedFixture, roundFixture, signaturesFixture } from "./helpers/signVerifyFixtures.mjs";

const VERIFY_CLI = resolve("scripts/verify-loadtest-signtofly.mjs");

async function writeCliArtifacts(cwd, baseUrl) {
  const prepared = { ...preparedFixture(), baseUrl };
  const artifact = artifactFixture(prepared);
  const eventsPath = join(cwd, "events.json");
  const summaryPath = join(cwd, "summary.json");
  await mkdir(join(cwd, "tests", "load"), { recursive: true });
  await Promise.all([
    writeFile(join(cwd, "tests", "load", ".prepared-round.json"), JSON.stringify(prepared)),
    writeFile(eventsPath, rawLines(artifact.events)),
    writeFile(summaryPath, JSON.stringify(artifact.summary)),
  ]);
  return { eventsPath, summaryPath };
}

function runCli(cwd, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VERIFY_CLI, ...args], {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stderr }));
  });
}

test("raw parser requires exact setup and attempt keys from Todo 9 JSON lines", () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  const jsonLines = rawLines(artifact.events);

  // When
  const parsed = parseRawVerificationArtifacts(prepared, jsonLines, artifact.summary);

  // Then
  assert.equal(parsed.targets.length, 185);
  assert.equal(parsed.final100.length, 100);
});

test("runner reports exact state and drains replay queue after flag convergence", async () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  const parsed = parseRawVerificationArtifacts(prepared, rawLines(artifact.events), artifact.summary);
  const signatures = signaturesFixture(parsed);
  const round = roundFixture(prepared, parsed);
  const order = [];

  // When
  const report = await runSignVerification({
    prepared, parsed, dedicatedStack: true,
    login: async () => "token",
    getSignatures: async () => signatures,
    postReplay: async () => { order.push("replay"); return { status: 200, id: signatures[0].id }; },
    loadRound: async () => { order.push("flags"); return round; },
    waitForQueues: async () => { order.push("queues"); return { main: 0, poison: 0, stable: true }; },
    flagPolling: { deadlineMs: 10, intervalMs: 2, now: () => 0, sleep: async () => undefined },
  });

  // Then
  assert.deepEqual(order, ["flags", "replay", "queues"]);
  assert.equal(report.output, "targets=185 signatures=185 uniqueSignatureKeys=185 signedFlags=185 finalBurst=100/100 unsignedNonTargets=315 reflectQueues=main:0,poison:0,stable replay=fallback");
});

test("runner refuses queue claims without a dedicated stack", async () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  const parsed = parseRawVerificationArtifacts(prepared, rawLines(artifact.events), artifact.summary);

  // When / Then
  await assert.rejects(() => runSignVerification({
    prepared, parsed, dedicatedStack: false,
  }), /dedicated stack/);
});

test("CLI parses artifacts before HTTP login or queue client construction", async () => {
  // Given / When
  const source = await import("node:fs/promises").then(({ readFile }) => (
    readFile(new URL("../verify-loadtest-signtofly.mjs", import.meta.url), "utf8")
  ));

  // Then
  const parseAt = source.indexOf("parseRawVerificationArtifacts(prepared, jsonLines, summary)");
  assert.ok(parseAt >= 0);
  assert.ok(parseAt < source.indexOf("createVerifierApi("));
  assert.ok(parseAt < source.indexOf("login(ADMIN_EMAIL"));
  assert.ok(parseAt < source.indexOf("createReflectQueueReader("));
});

test("standalone verifier rejects an unclassified target before credential-file access", async (t) => {
  // Given
  const cwd = await mkdtemp(join(tmpdir(), "bcc-verify-target-"));
  const baseUrl = "https://api.example.test";
  const paths = await writeCliArtifacts(cwd, baseUrl);
  await mkdir(join(cwd, ".dev-credentials"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  // When
  const result = await runCli(cwd, Object.values(paths), {
    BCC_API_BASE_URL: baseUrl,
    ADMIN_PASSWORD: "",
    LOADTEST_DEDICATED_STACK: "1",
  });

  // Then
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hostname must contain loadtest or staging/);
  assert.doesNotMatch(result.stderr, /EISDIR|credential|password/iu);
});

test("standalone verifier requires dedicated confirmation before login or queue clients", async (t) => {
  // Given
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accessToken: "must-not-be-used" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cwd = await mkdtemp(join(tmpdir(), "bcc-verify-dedicated-"));
  const paths = await writeCliArtifacts(cwd, baseUrl);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  // When
  const result = await runCli(cwd, Object.values(paths), {
    BCC_API_BASE_URL: baseUrl,
    ADMIN_PASSWORD: "must-not-be-used",
    AzureWebJobsStorage: "invalid-connection-string",
    LOADTEST_DEDICATED_STACK: "0",
  });

  // Then
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dedicated stack confirmation/);
  assert.equal(requests, 0);
  assert.doesNotMatch(result.stderr, /connection string|AzureWebJobsStorage/iu);
});

test("verifier API uses one bounded fetch attempt and preserves status", async () => {
  // Given
  const calls = [];
  const callApi = createVerifierApi({
    baseUrl: "http://worker.invalid",
    deadlineMs: 100,
    now: () => 0,
    abortSignalFactory: (timeoutMs) => ({ timeoutMs }),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { status: 200, ok: true, text: async () => JSON.stringify({ id: "signature-1" }) };
    },
  });

  // When
  const response = await callApi("POST", "/api/replay", { token: "token" });

  // Then
  assert.deepEqual(response, { status: 200, json: { id: "signature-1" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal.timeoutMs, 100);
});

test("verifier API sanitizes response body read failures", async () => {
  // Given
  const callApi = createVerifierApi({
    baseUrl: "http://worker.invalid", deadlineMs: 100, now: () => 0,
    fetch: async () => ({ status: 200, text: async () => { throw new Error("secret body"); } }),
  });

  // When / Then
  await assert.rejects(() => callApi("GET", "/api/round"), (error) => {
    assert.match(error.message, /response read failed.*state preserved/);
    assert.doesNotMatch(error.message, /secret body/);
    return true;
  });
});

function rawLines(attempts) {
  const lines = [];
  for (const event of attempts) {
    lines.push(point("sign_setup_attempts", {
      cohort: event.cohort, group: "", slot_key: event.slotKey, status: "200", outcome: "authenticated",
    }));
    lines.push(point("sign_attempts", {
      cohort: event.cohort, group: "", phase: "sign", scenario: `sign_${event.cohort}`,
      slot_key: event.slotKey, status: String(event.status), signature_id: event.signatureId,
      outcome: event.outcome,
    }));
  }
  return `${lines.map(JSON.stringify).join("\n")}\n`;
}

function point(metric, tags) {
  return { metric, type: "Point", data: { value: 1, tags } };
}
