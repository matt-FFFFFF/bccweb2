// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Typed API client — all /api/* calls go through here.
 *
 * Features:
 * - Attaches JWT access token as Authorization: Bearer header
 * - 401 auto-refresh with single-flight singleton: one refresh for N concurrent callers
 * - Typed ApiError with code/status/requestId/detail matching the server error shape
 */

const ACCESS_TOKEN_KEY = "bcc_access_token";
const REFRESH_TOKEN_KEY = "bcc_refresh_token";
const IDENTITY_KEY = "bcc_identity";

// ─── ApiError ────────────────────────────────────────────────────────────────

/** Server error body shape (defined in apps/api/src/lib/http.ts withErrorHandler). */
interface ApiErrorBody {
  error: string;
  code: string;
  requestId?: string;
  detail?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly detail?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function defaultCode(status: number): string {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 422) return "UNPROCESSABLE_ENTITY";
  if (status === 423) return "LOCKED";
  if (status === 429) return "RATE_LIMITED";
  return status >= 500 ? "INTERNAL" : "ERROR";
}

// ─── Single-flight refresh ───────────────────────────────────────────────────

/**
 * Module-level singleton — exactly one refresh in flight at a time across all
 * concurrent callers. Cleared to null via .finally() when the refresh settles.
 */
let refreshInFlight: Promise<string> | null = null;

/**
 * POST /api/auth/refresh with the stored refresh token.
 * Writes the new access token to localStorage BEFORE resolving so all retried
 * requests reading localStorage see the updated value.
 * On failure: clears all bcc_* keys and dispatches bcc:auth-expired.
 */
async function refreshAccessToken(): Promise<string> {
  window.dispatchEvent(new CustomEvent("bcc:refresh-start"));
  try {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!refreshToken) throw new Error("No refresh token stored");

    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) throw new Error("Token refresh failed");

    const { accessToken } = (await res.json()) as { accessToken: string };
    // Must update localStorage BEFORE returning so retried callers see the new token
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    return accessToken;
  } catch (err) {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(IDENTITY_KEY);
    window.dispatchEvent(new CustomEvent("bcc:auth-expired"));
    throw err;
  } finally {
    window.dispatchEvent(new CustomEvent("bcc:refresh-end"));
  }
}

// ─── Core fetch ──────────────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  retried = false
): Promise<T> {
  const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await fetch(`/api/${path}`, {
    ...options,
    headers,
  });

  // 401 + not yet retried + have a refresh token → single-flight refresh then retry once.
  // 403 is a permission denial, NOT an expired-token signal — never refresh on 403.
  if (response.status === 401 && !retried && localStorage.getItem(REFRESH_TOKEN_KEY)) {
    // The check and assignment are synchronous (no await between them) so concurrent
    // callers arriving here observe the same in-flight promise instead of creating
    // multiple refresh requests.
    if (refreshInFlight === null) {
      refreshInFlight = refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
    }
    // All concurrent callers await the SAME promise.
    await refreshInFlight;
    // Retry exactly once with the new token now present in localStorage.
    return apiFetch<T>(path, options, true);
  }

  if (!response.ok) {
    let body: Partial<ApiErrorBody> = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // ignore parse errors
    }
    throw new ApiError(
      response.status,
      body.code ?? defaultCode(response.status),
      body.error ?? `API error ${response.status}`,
      body.requestId,
      body.detail
    );
  }

  // 204 No Content — return undefined cast to T
  if (response.status === 204) return undefined as T;

  return response.json() as Promise<T>;
}

// ─── Typed wrappers ───────────────────────────────────────────────────────────

export const api = {
  get<T>(path: string): Promise<T> {
    return apiFetch<T>(path);
  },

  post<T>(path: string, body?: unknown): Promise<T> {
    return apiFetch<T>(path, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  },

  put<T>(path: string, body?: unknown): Promise<T> {
    return apiFetch<T>(path, {
      method: "PUT",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  },

  /**
   * DELETE wrapper for endpoints that return 204 No Content.
   *
   * If you call this on an endpoint that returns a JSON body (200 + payload),
   * the underlying apiFetch() will attempt response.json() and the promise
   * resolves to that parsed value (not void) — use `deleteJson<T>()` instead
   * for typed access to that body.
   */
  delete(path: string): Promise<void> {
    return apiFetch<void>(path, { method: "DELETE" });
  },

  /**
   * DELETE that REQUIRES a JSON response body.
   * Throws if the endpoint returns 204 (use {@link api.delete} for that).
   */
  async deleteJson<T>(path: string): Promise<T> {
    const result = await apiFetch<T | undefined>(path, { method: "DELETE" });
    if (result === undefined) {
      throw new ApiError(
        204,
        "NO_CONTENT",
        `DELETE ${path} returned 204 but caller expected JSON body — use api.delete(path)`
      );
    }
    return result;
  },
};
