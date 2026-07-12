// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  LoadTestHttpError,
  RETRY_AFTER_SAFETY_MARGIN_MS,
  loadTestFetch,
} from "../lib/loadTestHttp.mjs";
import { createLoadTestApi } from "../lib/loadTestApi.mjs";

const transitionScript = resolve("scripts/transition-loadtest.mjs");

test("transition exits after one permanent-error request", async (t) => {
  // Given
  const cwd = await mkdtemp(join(tmpdir(), "bcc-transition-baseline-"));
  t.after(async () => {
    await rm(cwd, { recursive: true });
  });
  await mkdir(join(cwd, "tests/load"), { recursive: true });
  await writeFile(
    join(cwd, "tests/load/.prepared-round.json"),
    JSON.stringify({ roundId: "round-baseline" })
  );

  const callsPath = join(cwd, "fetch-calls.txt");
  const hookPath = join(cwd, "fetch-hook.mjs");
  await writeFile(
    hookPath,
    `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url) => {
  appendFileSync(${JSON.stringify(callsPath)}, String(url) + "\\n");
  if (String(url).endsWith("/api/auth/login")) {
    return new Response(JSON.stringify({ accessToken: "test-token" }), { status: 200 });
  }
  return new Response("permanent failure", { status: 500 });
};
`
  );

  // When
  const result = spawnSync(process.execPath, ["--import", hookPath, transitionScript], {
    cwd,
    env: { ...process.env, ADMIN_PASSWORD: "test-password" },
    encoding: "utf8",
  });

  // Then
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 500: permanent failure/);
  const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
  assert.equal(calls.filter((url) => url.endsWith("/brief-complete")).length, 1);
});

function response(status, body, retryAfter) {
  return new Response(body, {
    status,
    headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
  });
}

function fakeRuntime(responses, startMs = 1_000) {
  let currentMs = startMs;
  let attempts = 0;
  const waits = [];
  const logs = [];
  return {
    options: {
      deadlineMs: startMs + 10_000,
      retry429: true,
      fetch: async () => {
        const next = responses[attempts];
        attempts += 1;
        assert.ok(next, `unexpected request attempt ${attempts}`);
        return next;
      },
      sleep: async (ms) => {
        waits.push(ms);
        currentMs += ms;
      },
      now: () => currentMs,
      log: (message) => logs.push(message),
    },
    attempts: () => attempts,
    waits,
    logs,
  };
}

test("429 waits for Retry-After plus safety margin before retrying", async () => {
  // Given
  const runtime = fakeRuntime([
    response(429, "slow down", "2"),
    response(200, "ready"),
  ]);

  // When
  const result = await loadTestFetch(
    "https://example.invalid/setup",
    { headers: { Authorization: "Bearer secret-token" } },
    runtime.options
  );

  // Then
  assert.equal(await result.text(), "ready");
  assert.equal(runtime.attempts(), 2);
  assert.deepEqual(runtime.waits, [2_000 + RETRY_AFTER_SAFETY_MARGIN_MS]);
  assert.equal(runtime.logs.length, 1);
  assert.doesNotMatch(runtime.logs[0], /secret-token|Authorization|example\.invalid/);
});

test("Retry-After zero still applies the safety margin", async () => {
  // Given
  const runtime = fakeRuntime([response(429, "slow down", "0"), response(204, null)]);

  // When
  const result = await loadTestFetch("https://example.invalid/setup", {}, runtime.options);

  // Then
  assert.equal(result.status, 204);
  assert.deepEqual(runtime.waits, [RETRY_AFTER_SAFETY_MARGIN_MS]);
});

test("429 is single-attempt unless retry handling is enabled", async () => {
  // Given
  const runtime = fakeRuntime([response(429, "rate limited", "2")]);
  runtime.options.retry429 = false;

  // When / Then
  await assert.rejects(
    loadTestFetch("https://example.invalid/setup", {}, runtime.options),
    (error) => error instanceof LoadTestHttpError && error.status === 429
  );
  assert.equal(runtime.attempts(), 1);
  assert.deepEqual(runtime.waits, []);
});

test("repeated 429 responses stop before the deadline would be exceeded", async () => {
  // Given
  const runtime = fakeRuntime([
    response(429, "first limit", "1"),
    response(429, "second limit", "1"),
  ]);
  runtime.options.deadlineMs = 2_500;

  // When / Then
  await assert.rejects(
    loadTestFetch("https://example.invalid/setup", {}, runtime.options),
    (error) => {
      assert.ok(error instanceof LoadTestHttpError);
      assert.equal(error.status, 429);
      assert.equal(error.body, "second limit");
      assert.match(error.message, /deadline/);
      return true;
    }
  );
  assert.equal(runtime.attempts(), 2);
  assert.deepEqual(runtime.waits, [1_000 + RETRY_AFTER_SAFETY_MARGIN_MS]);
});

for (const retryAfter of [undefined, "", "1.5", "-1", "NaN", "Infinity"]) {
  test(`429 rejects invalid Retry-After ${JSON.stringify(retryAfter)}`, async () => {
    // Given
    const runtime = fakeRuntime([response(429, "rate limited", retryAfter)]);

    // When / Then
    await assert.rejects(
      loadTestFetch("https://example.invalid/setup", {}, runtime.options),
      (error) => {
        assert.ok(error instanceof LoadTestHttpError);
        assert.equal(error.status, 429);
        assert.equal(error.body, "rate limited");
        assert.match(error.message, /Retry-After/);
        return true;
      }
    );
    assert.equal(runtime.attempts(), 1);
    assert.deepEqual(runtime.waits, []);
  });
}

test("a huge Retry-After is bounded by the deadline without sleeping", async () => {
  // Given
  const runtime = fakeRuntime([response(429, "long limit", "9007199254740992")]);

  // When / Then
  await assert.rejects(
    loadTestFetch("https://example.invalid/setup", {}, runtime.options),
    (error) => error instanceof LoadTestHttpError && /deadline/.test(error.message)
  );
  assert.equal(runtime.attempts(), 1);
  assert.deepEqual(runtime.waits, []);
});

for (const status of [400, 409, 500]) {
  test(`HTTP ${status} fails after exactly one attempt`, async () => {
    // Given
    const runtime = fakeRuntime([response(status, `failure ${status}`)]);

    // When / Then
    await assert.rejects(
      loadTestFetch("https://example.invalid/setup", {}, runtime.options),
      (error) => {
        assert.ok(error instanceof LoadTestHttpError);
        assert.equal(error.status, status);
        assert.equal(error.body, `failure ${status}`);
        assert.equal(error.response.status, status);
        return true;
      }
    );
    assert.equal(runtime.attempts(), 1);
    assert.deepEqual(runtime.waits, []);
  });
}

for (const deadlineMs of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`requires a finite deadline: ${String(deadlineMs)}`, async () => {
    // Given
    const runtime = fakeRuntime([response(200, "unused")]);
    runtime.options.deadlineMs = deadlineMs;

    // When / Then
    await assert.rejects(
      loadTestFetch("https://example.invalid/setup", {}, runtime.options),
      /finite deadlineMs/
    );
    assert.equal(runtime.attempts(), 0);
  });
}

test("a new invocation has fresh retry state after deadline failure", async () => {
  // Given
  const failed = fakeRuntime([response(429, "limit", "20")]);
  const fresh = fakeRuntime([response(200, "fresh")], 50_000);

  // When
  await assert.rejects(loadTestFetch("https://example.invalid/setup", {}, failed.options));
  const result = await loadTestFetch("https://example.invalid/setup", {}, fresh.options);

  // Then
  assert.equal(await result.text(), "fresh");
  assert.equal(failed.attempts(), 1);
  assert.equal(fresh.attempts(), 1);
  assert.deepEqual(fresh.waits, []);
});

test("API creates a fresh timeout signal for every 429 retry attempt", async () => {
  // Given
  let now = 1_000;
  const signals = [];
  const createdSignals = [];
  const responses = [response(429, "first", "0"), response(429, "second", "0"), response(200, "{}")];
  const callApi = createLoadTestApi({
    baseUrl: "https://loadtest.invalid",
    deadlineMs: 10_000,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    abortSignalFactory: (timeoutMs) => {
      const signal = { timeoutMs, attempt: createdSignals.length + 1 };
      createdSignals.push(signal);
      return signal;
    },
    fetch: async (_url, init) => {
      signals.push(init.signal);
      return responses.shift();
    },
  });

  // When
  await callApi("POST", "/api/setup", { body: {} });

  // Then
  assert.equal(signals.length, 3);
  assert.equal(new Set(signals).size, 3);
  assert.deepEqual(signals, createdSignals);
});
