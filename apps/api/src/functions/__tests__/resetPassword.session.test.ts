/**
 * authFunctions.ts — password-reset session invalidation (issue #122, T5).
 *
 * `resetPassword` bumps the RELIABLE refresh kill (cred.tokenVersion) AND, best-effort,
 * the user's LIVE access token by bumping user.sessionVersion. A failure of the
 * sessionVersion bump must NOT break the reset: it stays 200 and emits
 * `session.invalidate.partial` telemetry.
 *
 * Test A proves a pre-reset access token dies (401) after a normal reset.
 * Test B fault-injects the sessionVersion write (non-404) and proves the reset still
 * returns 200 and fires the partial-invalidation telemetry — surgically, so the
 * auth/{id} cred write, token CAS consume, and token mint stay real.
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
// `users/` sessionVersion write when the flag is set. resetPassword's cred write uses
// withPrivateLease (untouched), consumeShortLivedToken uses ETag CAS (untouched), and
// generateShortLivedToken writes auth/tokens/* (untouched) — all unaffected.
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

import { generateShortLivedToken } from "../../lib/authHelpers.js";
import { invoke, makeAuthRequest, makeRequest } from "../../__tests__/helpers/api.js";
import { makeUser, readPrivateJson } from "../../__tests__/helpers/seed.js";
import "../authFunctions.js";
import "../me.js";

afterEach(() => {
  blobFault.failSessionWrite = false;
  vi.clearAllMocks();
});

describe("POST /api/auth/reset-password — issue #122 live access-token invalidation", () => {
  test("a pre-reset access token is rejected (401) after reset; sessionVersion bumped 0→1", async () => {
    const { user: u } = await makeUser({ emailVerified: true });

    // Mint U's access token BEFORE the reset → sessionVersion 0.
    const oldToken = makeAuthRequest(u.id, u.email, { method: "GET" });

    // Valid reset token, minted with the fault flag OFF (real impl).
    const resetToken = await generateShortLivedToken(u.id, "reset", 1);

    const resetRes = await invoke(
      "authResetPassword",
      makeRequest({ method: "POST", body: { token: resetToken, newPassword: "newpassword123" } }),
    );
    expect(resetRes.status).toBe(200);

    // The pre-reset token is now stale (token sv 0 !== user sv 1) → 401.
    // Do NOT re-mint: proving the LIVE token is dead is the whole point.
    const meRes = await invoke("me", oldToken);
    expect(meRes.status).toBe(401);

    const persisted = await readPrivateJson<User>(`users/${u.id}.json`);
    expect(persisted?.sessionVersion).toBe(1);
  });

  test("best-effort: a non-404 sessionVersion write failure still returns 200 and fires telemetry", async () => {
    const { user: u } = await makeUser({ emailVerified: true });

    // Mint the reset token BEFORE flipping the fault (seeding + token creation use real impl).
    const resetToken = await generateShortLivedToken(u.id, "reset", 1);

    // Break ONLY the users/{id} sessionVersion write; cred write, token consume, and mint stay real.
    blobFault.failSessionWrite = true;

    const resetRes = await invoke(
      "authResetPassword",
      makeRequest({ method: "POST", body: { token: resetToken, newPassword: "newpassword123" } }),
    );
    expect(resetRes.status).toBe(200);

    expect(telemetryMock.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "session.invalidate.partial",
        properties: expect.objectContaining({ op: "reset", userId: u.id }),
      }),
    );
  });
});
