import { randomUUID } from "crypto";
import type { HttpRequest } from "@azure/functions";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import type { User } from "@bccweb/types";
import { UserSchema } from "@bccweb/schemas";
import { getCallerIdentity } from "../auth.js";
import { writePrivateJson } from "../blobJson.js";
import { invoke, makeAuthRequest, makeRequest, MockHttpRequest } from "../../__tests__/helpers/api.js";
import { makeUser } from "../../__tests__/helpers/seed.js";

// issue #122: an access token is version-bound to the user's `sessionVersion`. Bumping the user's
// value (email-change / logout / reset — later tasks) must immediately reject every prior token.

function baseUser(id: string, email: string, sessionVersion?: number): User {
  return {
    id,
    email,
    roles: [],
    pilotId: null,
    clubId: null,
    createdAt: new Date().toISOString(),
    ...(sessionVersion === undefined ? {} : { sessionVersion }),
  };
}

function reqWithToken(token: string): HttpRequest {
  return new MockHttpRequest({
    headers: { authorization: `Bearer ${token}` },
  }) as unknown as HttpRequest;
}

describe("getCallerIdentity sessionVersion binding (issue #122)", () => {
  it("rejects (null) a token whose sessionVersion is behind the user's", async () => {
    const userId = randomUUID();
    const email = `sv-stale-${userId.slice(0, 8)}@example.com`;
    // TEST SETUP: no seeding handler stamps sessionVersion yet (T3+ will), so write the user
    // blob directly with an already-invalidated session (sessionVersion 1).
    await writePrivateJson(`users/${userId}.json`, UserSchema, baseUser(userId, email, 1));

    const req = makeAuthRequest(userId, email, { sessionVersion: 0 }) as unknown as HttpRequest;

    expect(await getCallerIdentity(req)).toBeNull();
  });

  it("accepts a token whose sessionVersion matches the user's", async () => {
    const userId = randomUUID();
    const email = `sv-match-${userId.slice(0, 8)}@example.com`;
    await writePrivateJson(`users/${userId}.json`, UserSchema, baseUser(userId, email, 1));

    const req = makeAuthRequest(userId, email, { sessionVersion: 1 }) as unknown as HttpRequest;

    const identity = await getCallerIdentity(req);
    expect(identity).not.toBeNull();
    expect(identity?.userId).toBe(userId);
  });

  it("accepts a pre-deploy token that carries no sessionVersion claim (back-compat)", async () => {
    const userId = randomUUID();
    const email = `sv-legacy-${userId.slice(0, 8)}@example.com`;
    // user has NO sessionVersion key — the pre-issue-#122 blob shape.
    await writePrivateJson(`users/${userId}.json`, UserSchema, baseUser(userId, email));

    // Simulate a token minted before deploy: signed WITHOUT a sessionVersion claim.
    const token = jwt.sign(
      { sub: userId, email, type: "access" },
      process.env["JWT_SECRET"] as string,
      { algorithm: "HS256", expiresIn: "1h" },
    );

    const identity = await getCallerIdentity(reqWithToken(token));
    expect(identity).not.toBeNull();
    expect(identity?.userId).toBe(userId);
  });

  it("mints an identical sessionVersion from login and refresh, both accepted", async () => {
    const { user, password } = await makeUser();
    // Bump to a non-zero version so the assertion proves the value is READ, not hardcoded 0.
    await writePrivateJson(`users/${user.id}.json`, UserSchema, { ...user, sessionVersion: 2 });

    const loginRes = await invoke(
      "authLogin",
      makeRequest({
        method: "POST",
        headers: { "x-forwarded-for": `${randomUUID()}.sv` },
        body: { email: user.email, password },
      }),
    );
    expect(loginRes.status).toBe(200);
    const loginBody = loginRes.jsonBody as { accessToken: string; refreshToken: string };

    const refreshRes = await invoke(
      "authRefresh",
      makeRequest({
        method: "POST",
        headers: { "x-forwarded-for": `${randomUUID()}.sv` },
        body: { refreshToken: loginBody.refreshToken },
      }),
    );
    expect(refreshRes.status).toBe(200);
    const refreshBody = refreshRes.jsonBody as { accessToken: string };

    const loginClaims = jwt.decode(loginBody.accessToken) as { sessionVersion?: number };
    const refreshClaims = jwt.decode(refreshBody.accessToken) as { sessionVersion?: number };
    expect(loginClaims.sessionVersion).toBe(2);
    expect(refreshClaims.sessionVersion).toBe(loginClaims.sessionVersion);

    expect((await getCallerIdentity(reqWithToken(loginBody.accessToken)))?.userId).toBe(user.id);
    expect((await getCallerIdentity(reqWithToken(refreshBody.accessToken)))?.userId).toBe(user.id);
  });

  it("returns exactly null on mismatch — never throws, never a stale-email identity", async () => {
    const userId = randomUUID();
    const email = `sv-guard-${userId.slice(0, 8)}@example.com`;
    await writePrivateJson(`users/${userId}.json`, UserSchema, baseUser(userId, email, 5));

    const req = makeAuthRequest(userId, email, { sessionVersion: 4 }) as unknown as HttpRequest;

    // The guard must resolve to null, not throw — this is the assertion that breaks if `!==`
    // is ever weakened to `===`.
    let identity: Awaited<ReturnType<typeof getCallerIdentity>> | undefined;
    let threw = false;
    try {
      identity = await getCallerIdentity(req);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(identity).toBeNull();
  });
});
