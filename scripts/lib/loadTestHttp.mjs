// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

export const RETRY_AFTER_SAFETY_MARGIN_MS = 100;

export class LoadTestHttpError extends Error {
  constructor(message, { response, body, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LoadTestHttpError";
    this.status = response?.status;
    this.response = response;
    this.body = body;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return seconds * 1_000 + RETRY_AFTER_SAFETY_MARGIN_MS;
}

async function httpError(response, message) {
  try {
    const body = await response.text();
    return new LoadTestHttpError(message, { response, body });
  } catch (cause) {
    return new LoadTestHttpError(message, { response, cause });
  }
}

export async function loadTestFetch(url, init, options) {
  const {
    deadlineMs,
    retry429 = false,
    fetch: fetchFn = globalThis.fetch,
    sleep = defaultSleep,
    now = Date.now,
    log = console.error,
    beforeAttempt = (requestInit) => requestInit,
  } = options ?? {};

  if (!Number.isFinite(deadlineMs)) {
    throw new TypeError("loadTestFetch requires a finite deadlineMs");
  }

  let attempt = 0;
  while (true) {
    const requestStartedAt = now();
    if (!Number.isFinite(requestStartedAt) || requestStartedAt >= deadlineMs) {
      throw new LoadTestHttpError("Load-test HTTP deadline reached before request");
    }

    attempt += 1;
    const response = await fetchFn(url, beforeAttempt(init, attempt));
    if (response.ok) return response;

    if (response.status !== 429 || !retry429) {
      throw await httpError(response, `Load-test HTTP request failed with status ${response.status}`);
    }

    const retryAfter = response.headers.get("Retry-After");
    const waitMs = parseRetryAfterMs(retryAfter);
    if (waitMs === null) {
      throw await httpError(response, "HTTP 429 response has invalid Retry-After delta-seconds");
    }

    const retryAt = now() + waitMs;
    if (!Number.isFinite(retryAt) || retryAt >= deadlineMs) {
      throw await httpError(response, "HTTP 429 retry would reach or exceed deadline");
    }

    log(
      `[load-test-http] rate limited; retrying attempt=${attempt + 1} waitMs=${waitMs} remainingMs=${deadlineMs - retryAt}`
    );
    await sleep(waitMs);
  }
}
