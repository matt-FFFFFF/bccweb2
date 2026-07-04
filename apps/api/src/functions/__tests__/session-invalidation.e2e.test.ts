/**
 * session-invalidation.e2e.test.ts — issue #122 end-to-end lock (T8).
 *
 * Two integration tests that pin the WHOLE feature together (test-only, no prod code):
 *
 *  1. BACK-COMPAT (no mass logout on deploy): a pre-issue-#122 user blob (NO
 *     sessionVersion key) + a pre-deploy access token (NO sessionVersion claim)
 *     still authenticates. This is the `?? 0` back-compat contract — without it,
 *     the first post-deploy request from every existing user would 401.
 *
 *  2. FULL FLOW: mint U's live access token → admin changes U's email (bumps
 *     sessionVersion, kills the live token, emails a verify link to the NEW
 *     address) → U's OLD token is now 401 → consume the verify token → login with
 *     the NEW email → the fresh token authenticates on an authed endpoint. The
 *     intermediate `old → 401` and `verify → 200` assertions are the regression
 *     guards; do NOT re-mint the old token before the 401 check.
 */

import jwt from "jsonwebtoken";
import { describe, expect, test } from "vitest";
import { clearSentEmails, getSentEmails } from "../../__tests__/helpers/setup.js";
import { invoke, makeAuthRequest, makeRequest, MockHttpRequest } from "../../__tests__/helpers/api.js";
import { bootstrapAdmin, makeUser, readPrivateJson } from "../../__tests__/helpers/seed.js";
import { verificationStatePath, type VerificationState } from "../../lib/authHelpers.js";
import "../admin.js";
import "../authFunctions.js";
import "../me.js";

/** A bare authed request carrying `token` verbatim (used for legacy / re-minted tokens). */
function reqWithToken(token: string): MockHttpRequest {
  return new MockHttpRequest({ headers: { authorization: `Bearer ${token}` } });
}

describe("issue #122 — session invalidation end-to-end (T8)", () => {
  test("back-compat: a legacy user + pre-deploy token (no sessionVersion) still authenticates (no mass logout)", async () => {
    // user blob has NO sessionVersion key — the pre-issue-#122 shape.
    const { user: u } = await makeUser({ emailVerified: true });

    // Simulate a token minted before deploy: signed WITHOUT a sessionVersion claim.
    const legacyToken = jwt.sign(
      { sub: u.id, email: u.email, type: "access" },
      process.env["JWT_SECRET"] as string,
      { algorithm: "HS256", expiresIn: "1h" },
    );

    const res = await invoke("me", reqWithToken(legacyToken));
    expect(res.status).toBe(200);
    expect((res.jsonBody as { userId: string }).userId).toBe(u.id);
  });

  test("full flow: live token dies on email change, verify + re-login restores access", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: u, password } = await makeUser({ emailVerified: true });
    clearSentEmails();

    // Mint U's live access token BEFORE the change → sessionVersion 0.
    const oldToken = makeAuthRequest(u.id, u.email, { method: "GET" });

    const newEmail = `e2e-${u.id.slice(0, 8)}@example.com`;
    const change = await invoke(
      "updateUserEmail",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: u.id },
        body: { email: newEmail },
      }),
    );
    expect(change.status).toBe(200);

    // (a) the live access token is now dead (token sv 0 !== user sv 1). Do NOT re-mint.
    expect((await invoke("me", oldToken)).status).toBe(401);

    // (b) a verification link was emailed to the NEW address.
    const sent = getSentEmails().at(-1);
    expect(sent?.to).toContain(newEmail);

    // (c) consume the verify token (restores emailVerified for the new address).
    const state = await readPrivateJson<VerificationState>(verificationStatePath(u.id));
    expect(state?.token).toBeTruthy();
    const verify = await invoke(
      "authVerifyEmail",
      makeRequest({ method: "GET", query: { token: state!.token } }),
    );
    expect(verify.status).toBe(200);

    // (d) login with the NEW email now works (must come AFTER verify).
    const login = await invoke(
      "authLogin",
      makeRequest({
        method: "POST",
        headers: { "x-forwarded-for": `${u.id}.e2e` },
        body: { email: newEmail, password },
      }),
    );
    expect(login.status).toBe(200);
    const newAccess = (login.jsonBody as { accessToken: string }).accessToken;

    // (e) the fresh token validates on an authed endpoint.
    const me2 = await invoke("me", reqWithToken(newAccess));
    expect(me2.status).toBe(200);
    expect((me2.jsonBody as { userId: string }).userId).toBe(u.id);
  });
});
