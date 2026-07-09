// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../api";

// ─── Constants ───────────────────────────────────────────────────────────────

const ACCESS_TOKEN_KEY = "bcc_access_token";
const REFRESH_TOKEN_KEY = "bcc_refresh_token";
const IDENTITY_KEY = "bcc_identity";

const OLD_TOKEN = "old-access-token";
const NEW_TOKEN = "new-access-token";
const REFRESH_TOKEN_VAL = "valid-refresh-token";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function seedTokens() {
  localStorage.setItem(ACCESS_TOKEN_KEY, OLD_TOKEN);
  localStorage.setItem(REFRESH_TOKEN_KEY, REFRESH_TOKEN_VAL);
}

function getAuthHeader(init?: RequestInit): string {
  return (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
}

function getUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("api", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    localStorage.clear();
  });

  // ── single-flight refresh ─────────────────────────────────────────────────

  describe("single-flight refresh", () => {
    it("fires exactly ONE POST /api/auth/refresh when 10 parallel requests receive 401, then all 10 resolve to 200", async () => {
      seedTokens();

      let refreshCallCount = 0;

      fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = getUrl(input);
        const auth = getAuthHeader(init);

        if (url.endsWith("/api/auth/refresh")) {
          refreshCallCount++;
          return makeJsonResponse(200, { accessToken: NEW_TOKEN });
        }

        // First pass: old token → 401. Retry with new token → 200.
        if (auth === `Bearer ${NEW_TOKEN}`) {
          return makeJsonResponse(200, { value: "ok" });
        }
        return makeJsonResponse(401, { error: "Unauthorized", code: "UNAUTHORIZED" });
      });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => api.get<{ value: string }>("resource"))
      );

      expect(refreshCallCount).toBe(1);
      expect(results).toHaveLength(10);
      results.forEach((r) => expect(r).toEqual({ value: "ok" }));
    });
  });

  // ── refresh failure ───────────────────────────────────────────────────────

  describe("refresh failure", () => {
    it("clears all bcc_* tokens from localStorage and dispatches bcc:auth-expired when refresh returns non-2xx", async () => {
      seedTokens();
      localStorage.setItem(IDENTITY_KEY, JSON.stringify({ userId: "u1", roles: [] }));

      const expiredEvents: Event[] = [];
      const handler = (e: Event) => expiredEvents.push(e);
      window.addEventListener("bcc:auth-expired", handler);

      fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
        const url = getUrl(input);
        // Both the resource call and the refresh call return 401
        if (url.endsWith("/api/auth/refresh")) {
          return makeJsonResponse(401, { error: "Unauthorized", code: "UNAUTHORIZED" });
        }
        return makeJsonResponse(401, { error: "Unauthorized", code: "UNAUTHORIZED" });
      });

      await expect(api.get("resource")).rejects.toThrow();

      expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
      expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
      expect(localStorage.getItem(IDENTITY_KEY)).toBeNull();
      expect(expiredEvents).toHaveLength(1);

      window.removeEventListener("bcc:auth-expired", handler);
    });
  });

  // ── 403 response ──────────────────────────────────────────────────────────

  describe("403 response", () => {
    it("does NOT attempt refresh and propagates ApiError with code from response body", async () => {
      seedTokens();

      let refreshCalled = false;
      fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
        const url = getUrl(input);
        if (url.endsWith("/api/auth/refresh")) {
          refreshCalled = true;
          return makeJsonResponse(200, { accessToken: NEW_TOKEN });
        }
        return makeJsonResponse(403, {
          error: "Forbidden",
          code: "FORBIDDEN",
          requestId: "rid-403",
        });
      });

      let thrown: unknown;
      try {
        await api.get("admin-only");
      } catch (err) {
        thrown = err;
      }

      expect(refreshCalled).toBe(false);
      expect(thrown).toBeInstanceOf(ApiError);
      const err = thrown as ApiError;
      expect(err.status).toBe(403);
      expect(err.code).toBe("FORBIDDEN");
      expect(err.requestId).toBe("rid-403");
    });
  });

  // ── retry-once ────────────────────────────────────────────────────────────

  describe("retry-once", () => {
    it("refresh succeeds but the retried request also returns 401 — NO second refresh, ApiError thrown", async () => {
      seedTokens();

      let refreshCallCount = 0;
      fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
        const url = getUrl(input);
        if (url.endsWith("/api/auth/refresh")) {
          refreshCallCount++;
          return makeJsonResponse(200, { accessToken: NEW_TOKEN });
        }
        // Always 401 regardless of which token was used
        return makeJsonResponse(401, { error: "Unauthorized", code: "UNAUTHORIZED" });
      });

      let thrown: unknown;
      try {
        await api.get("resource");
      } catch (err) {
        thrown = err;
      }

      expect(refreshCallCount).toBe(1);
      expect(thrown).toBeInstanceOf(ApiError);
      const err = thrown as ApiError;
      expect(err.status).toBe(401);
      expect(err.code).toBe("UNAUTHORIZED");
    });
  });

  // ── ApiError shape ────────────────────────────────────────────────────────

  describe("ApiError", () => {
    it("is instanceof Error and ApiError, exposes status/code/requestId/detail from response body", async () => {
      // No refresh token → no refresh attempt on non-401 error
      fetchSpy.mockResolvedValue(
        makeJsonResponse(404, {
          error: "Not Found",
          code: "NOT_FOUND",
          requestId: "req-abc",
          detail: "pilot not found",
        })
      );

      let thrown: unknown;
      try {
        await api.get("pilots/missing");
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).toBeInstanceOf(ApiError);
      const err = thrown as ApiError;
      expect(err.name).toBe("ApiError");
      expect(err.status).toBe(404);
      expect(err.code).toBe("NOT_FOUND");
      expect(err.requestId).toBe("req-abc");
      expect(err.detail).toBe("pilot not found");
      expect(err.message).toBe("Not Found");
    });
  });
});
