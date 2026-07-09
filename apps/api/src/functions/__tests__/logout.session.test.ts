// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * authFunctions.ts — logout session invalidation (issue #122, T4).
 *
 * `logout` bumps the RELIABLE refresh kill (cred.tokenVersion) AND, best-effort,
 * the caller's LIVE access token by bumping user.sessionVersion. A failure of the
 * sessionVersion bump must NOT break logout: it stays 204 and emits
 * `session.invalidate.partial` telemetry.
 *
 * Test A proves the live access token dies (401) after a normal logout.
 * Test B fault-injects the sessionVersion write (non-404) and proves logout still
 * returns 204 and fires the partial-invalidation telemetry — surgically, so the
 * auth/{id} cred revocation and getCallerIdentity's read stay real.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { User } from "@bccweb/types";

const telemetryMock = vi.hoisted(() => {
  const trackEvent = vi.fn();
  const trackTrace = vi.fn();
  return { trackEvent, trackTrace, client: { trackEvent, trackTrace } };
});
vi.mock("../../lib/telemetry.js", () => ({
  getTelemetryClient: () => telemetryMock.client,
  setup: vi.fn(),
  resetForTests: vi.fn(),
}));

// Surgical fault seam: replace ONLY withPrivateLeaseRetry, and only reject for the
// `users/` sessionVersion write when the flag is set. The cred revocation uses
// withPrivateLease (untouched), getCallerIdentity reads via readJson (untouched),
// and seeding's user-index withPrivateLeaseRetry delegates to the real impl.
const blobFault = vi.hoisted(() => ({ failSessionWrite: false }));
vi.mock("../../lib/blob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blob.js")>();
  return {
    ...actual,
    withPrivateLeaseRetry: vi.fn(
      (path: string, fn: (leaseId: string) => Promise<unknown>): Promise<unknown> => {
        if (blobFault.failSessionWrite && path.startsWith("users/")) {
          return Promise.reject(Object.assign(new Error("boom"), { statusCode: 500 }));
        }
        return actual.withPrivateLeaseRetry(path, fn);
      },
    ),
  };
});

import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import { makeUser, readPrivateJson } from "../../__tests__/helpers/seed.js";
import "../authFunctions.js";
import "../me.js";

afterEach(() => {
  blobFault.failSessionWrite = false;
  vi.clearAllMocks();
});

describe("POST /api/auth/logout — issue #122 live access-token invalidation", () => {
  test("caller's OLD access token is rejected (401) after logout; sessionVersion bumped 0→1", async () => {
    const { user: u } = await makeUser({ emailVerified: true });

    // Mint the caller's token BEFORE logout → sessionVersion 0.
    const oldToken = makeAuthRequest(u.id, u.email, { method: "POST" });

    const logoutRes = await invoke("authLogout", oldToken);
    expect(logoutRes.status).toBe(204);

    // The pre-logout token is now stale (token sv 0 !== user sv 1) → 401.
    // Do NOT re-mint: proving the LIVE token is dead is the whole point.
    const meRes = await invoke("me", oldToken);
    expect(meRes.status).toBe(401);

    const persisted = await readPrivateJson<User>(`users/${u.id}.json`);
    expect(persisted?.sessionVersion).toBe(1);
  });

  test("best-effort: a non-404 sessionVersion write failure still returns 204 and fires telemetry", async () => {
    const { user: u } = await makeUser({ emailVerified: true });
    const token = makeAuthRequest(u.id, u.email, { method: "POST" });

    // Break ONLY the users/{id} sessionVersion write (getCallerIdentity's read and
    // the auth/{id} cred revocation stay real). Flag flips after seeding.
    blobFault.failSessionWrite = true;

    const logoutRes = await invoke("authLogout", token);
    expect(logoutRes.status).toBe(204);

    expect(telemetryMock.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "session.invalidate.partial",
        properties: expect.objectContaining({ op: "logout", userId: u.id }),
      }),
    );
  });
});
