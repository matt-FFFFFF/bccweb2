/**
 * admin.ts — email-change session invalidation (issue #122, T3).
 *
 * `updateUserEmail` bumps `user.sessionVersion` so the target user's LIVE
 * access token is rejected (401) on its next request. The bump piggybacks on
 * the user-blob write that already happens — 0 extra blob ops.
 *
 * TDD RED first: on pre-bump code the OLD token is still accepted (200), so the
 * first test fails; applying the +1 bump makes both tests pass.
 *
 * NOTE (do NOT "fix"): updateUserEmail also calls markAuthEmailUnverified
 * (emailVerified=false), so a REAL login with the new email would 403
 * EMAIL_NOT_VERIFIED. That verify-then-login flow is T8's job. Here we prove the
 * bump directly: the old token dies, and a correctly-versioned token still works.
 */

import { describe, expect, test } from "vitest";
import type { User } from "@bccweb/types";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import { bootstrapAdmin, makeUser, readPrivateJson } from "../../__tests__/helpers/seed.js";
import "../admin.js";
import "../authFunctions.js";
import "../me.js";

interface HandlerResult {
  status: number;
  jsonBody?: unknown;
}

const ctx = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  invocationId: "test-invocation",
} as never;

async function invoke(
  name: string,
  req: ReturnType<typeof makeAuthRequest>,
): Promise<HandlerResult> {
  const entry = getRegisteredHandler(name);
  if (!entry) throw new Error(`${name} not registered`);
  return (await entry.handler(req, ctx)) as HandlerResult;
}

describe("PUT /api/manage/users/{userId}/email — issue #122 access-token invalidation", () => {
  test("target user's OLD access token is rejected (401) after admin email-change", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    // Mint U's access token BEFORE the change → sessionVersion 0.
    const oldToken = makeAuthRequest(target.id, target.email, { method: "GET" });

    const newEmail = `rotated-${target.id.slice(0, 8)}@example.com`;
    const changeRes = await invoke(
      "updateUserEmail",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { email: newEmail },
      }),
    );
    expect(changeRes.status).toBe(200);

    // The pre-change token is now stale (token sv 0 !== user sv 1) → 401.
    // Do NOT re-mint: proving the LIVE token is dead is the whole point.
    const meRes = await invoke("me", oldToken);
    expect(meRes.status).toBe(401);
  });

  test("bump lands at exactly +1: a correctly-versioned new token is accepted (200)", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    const newEmail = `rotated-${target.id.slice(0, 8)}@example.com`;
    const changeRes = await invoke(
      "updateUserEmail",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { email: newEmail },
      }),
    );
    expect(changeRes.status).toBe(200);

    // A token minted at the POST-bump version (1) is accepted again.
    const freshToken = makeAuthRequest(target.id, newEmail, {
      method: "GET",
      sessionVersion: 1,
    });
    const meRes = await invoke("me", freshToken);
    expect(meRes.status).toBe(200);
    expect((meRes.jsonBody as { userId: string }).userId).toBe(target.id);

    // The user blob carries exactly sessionVersion 1 (started 0/undefined → +1).
    const persisted = await readPrivateJson<User>(`users/${target.id}.json`);
    expect(persisted?.sessionVersion).toBe(1);
  });
});
