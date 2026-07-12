// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { loadTestFetch } from "./loadTestHttp.mjs";

export class LoadTestApiError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "LoadTestApiError";
  }
}

export function createLoadTestApi(options) {
  const {
    baseUrl,
    deadlineMs,
    fetch = globalThis.fetch,
    log = console.error,
    now = Date.now,
    requestTimeoutMs = 30_000,
    sleep,
    abortSignalFactory = AbortSignal.timeout,
  } = options;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError("requestTimeoutMs must be a positive finite number");
  }

  return async function callApi(method, path, request = {}) {
    const headers = { "Content-Type": "application/json", ...request.headers };
    if (request.token) headers.Authorization = `Bearer ${request.token}`;
    const response = await loadTestFetch(
      `${baseUrl}${path}`,
      {
        method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      },
      {
        deadlineMs,
        retry429: true,
        fetch,
        log,
        now,
        beforeAttempt: (init) => {
          const remainingMs = deadlineMs - now();
          const timeoutMs = Math.max(1, Math.min(requestTimeoutMs, remainingMs));
          return { ...init, signal: abortSignalFactory(timeoutMs) };
        },
        ...(sleep === undefined ? {} : { sleep }),
      },
    );
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new LoadTestApiError(`${method} ${path} returned non-JSON`, { cause });
    }
  };
}

export async function loginLoadTestUser(callApi, credentials, headers = {}) {
  const response = await callApi("POST", "/api/auth/login", {
    body: credentials,
    headers,
  });
  if (typeof response?.accessToken !== "string" || response.accessToken.length === 0) {
    throw new LoadTestApiError(`login response missing accessToken for ${credentials.email}`);
  }
  return response.accessToken;
}
