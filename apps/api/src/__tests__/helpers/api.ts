/**
 * Test HTTP helpers — construct mock HttpRequest objects and invoke handlers.
 *
 * Handlers are captured via the mocked `@azure/functions` in setup.ts.
 * Tests import `getRegisteredHandler` from setup.ts and invoke handlers
 * directly with MockHttpRequest objects.
 */

import type { HttpResponseInit } from "@azure/functions";
import { signAccessToken } from "../../lib/authHelpers.js";
import { getRegisteredHandler } from "./setup.js";

// ─── MockHttpRequest ──────────────────────────────────────────────────────────

/**
 * Minimal HttpRequest-compatible mock that satisfies the interface used by all
 * handler functions. Supports .headers.get(), .params, .query.get(), .json().
 */
export class MockHttpRequest {
  readonly headers: Headers;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  private _body: unknown;
  readonly method: string;
  readonly url: string;

  constructor(options: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
  } = {}) {
    this.method = options.method ?? "GET";
    this.url = options.url ?? "http://localhost/api/test";
    this.headers = new Headers(options.headers ?? {});
    this.params = options.params ?? {};
    this.query = new URLSearchParams(options.query ?? {});
    this._body = options.body ?? null;
  }

  async json(): Promise<unknown> {
    return this._body;
  }

  async text(): Promise<string> {
    return typeof this._body === "string"
      ? this._body
      : JSON.stringify(this._body);
  }
}

// ─── Convenience request builders ─────────────────────────────────────────────

/**
 * Build an unauthenticated request.
 */
export function makeRequest(options: {
  method?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
} = {}): MockHttpRequest {
  return new MockHttpRequest(options);
}

/**
 * Build an authenticated request with a valid JWT for the given user.
 */
export function makeAuthRequest(
  userId: string,
  email: string,
  options: {
    method?: string;
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): MockHttpRequest {
  const token = signAccessToken(userId, email);
  return new MockHttpRequest({
    ...options,
    headers: {
      ...options.headers,
      authorization: `Bearer ${token}`,
    },
  });
}

// ─── Invoke helpers ───────────────────────────────────────────────────────────

/**
 * Invoke a registered handler by name with a request.
 * Handlers are captured by the @azure/functions mock in setup.ts.
 */
export async function invoke(
  handlerName: string,
  req: MockHttpRequest,
): Promise<HttpResponseInit> {
  const entry = getRegisteredHandler(handlerName);
  if (!entry) {
    throw new Error(
      `Handler "${handlerName}" not registered. Did you import the function module?`,
    );
  }
  // Pass a minimal InvocationContext stub
  const ctx = { log: console.log, warn: console.warn, error: console.error, functionName: handlerName };
  return entry.handler(req, ctx) as Promise<HttpResponseInit>;
}
