// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

function fail(message, options) {
  throw new Error(`[verify-loadtest-signtofly] ${message}`, options);
}

export function createVerifierApi(options) {
  const {
    baseUrl, deadlineMs, fetch = globalThis.fetch, now = Date.now,
    requestTimeoutMs = 30_000,
    abortSignalFactory = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  } = options;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) throw new TypeError("baseUrl is required");
  if (!Number.isFinite(deadlineMs)) throw new TypeError("deadlineMs must be finite");
  return async (method, path, request = {}) => {
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) fail(`deadline elapsed before ${method} ${path}; state preserved`);
    const headers = { "Content-Type": "application/json" };
    if (request.token) headers.Authorization = `Bearer ${request.token}`;
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: abortSignalFactory(Math.min(requestTimeoutMs, remainingMs)),
      });
    } catch (cause) {
      fail(`${method} ${path} request failed; state preserved`, { cause });
    }
    let text;
    try {
      text = await response.text();
    } catch (cause) {
      fail(`${method} ${path} response read failed; state preserved`, { cause });
    }
    let json = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch (cause) {
        fail(`${method} ${path} returned non-JSON; state preserved`, { cause });
      }
    }
    return { status: response.status, json };
  };
}
