import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomUUID } from "crypto";
import {
  clearSentEmails,
  getRegisteredHandler,
  getSentEmails,
} from "../../__tests__/helpers/setup.js";
import { makeRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import { generateShortLivedToken } from "../../lib/authHelpers.js";
import type { AuthCredential, AuthToken } from "../../lib/authHelpers.js";
import "../authFunctions.js";

interface HandlerResponse {
  status?: number;
  headers?: Record<string, string>;
  jsonBody?: Record<string, unknown>;
}

interface CredWithLockout extends AuthCredential {
  failedAttempts?: string[];
  lockedUntil?: string | null;
}

interface VerificationState {
  token: string;
  createdAt: string;
  expiresAt: string;
}

function ctxStub() {
  return {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    invocationId: "test-inv",
    functionName: "test",
  } as never;
}

async function invoke(
  handlerName: string,
  init: {
    method?: string;
    body?: unknown;
    query?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Promise<HandlerResponse> {
  const entry = getRegisteredHandler(handlerName);
  if (!entry) throw new Error(`Handler "${handlerName}" not registered`);
  const req = makeRequest({
    method: init.method,
    body: init.body,
    query: init.query,
    headers: init.headers,
  });
  return (await entry.handler(req as never, ctxStub())) as HandlerResponse;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function verificationStatePath(userId: string): string {
  return `auth/verification-state/${userId}.json`;
}

async function seedStaleVerificationState(
  userId: string,
  token: string,
  ageMs: number,
): Promise<void> {
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
  await writePrivateJson(verificationStatePath(userId), {
    token,
    createdAt,
    expiresAt,
  } as VerificationState);
  await writePrivateJson(`auth/tokens/${sha256Hex(token)}.json`, {
    userId,
    type: "verify",
    expiresAt,
  } as AuthToken);
}

async function seedExpiredVerifyToken(
  userId: string,
  token: string,
): Promise<void> {
  await writePrivateJson(`auth/tokens/${sha256Hex(token)}.json`, {
    userId,
    type: "verify",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  } as AuthToken);
}

const PASSWORD = "TestPass123!";

let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  const a = (ipCounter >> 8) & 0xff;
  const b = ipCounter & 0xff;
  return `198.51.${a}.${b}`;
}

describe("auth flow integration", () => {
  beforeEach(() => {
    resetAllBuckets();
    clearSentEmails();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("(1) register new email + acceptTsCs=true -> 202; one email; T&C persisted", async () => {
    const email = `int-new-${randomUUID()}@example.com`;
    const ip = uniqueIp();

    const res = await invoke("authRegister", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: { email, password: PASSWORD, acceptTsCs: true, acceptedTsCsVersion: 1 },
    });

    expect(res.status).toBe(202);
    const emails = getSentEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0]!.to).toEqual([email.toLowerCase()]);
    expect(emails[0]!.subject).toMatch(/Verify/i);

    const index = await readPrivateJson<Record<string, string>>("user-index.json");
    const userId = index![email.toLowerCase()];
    expect(userId).toBeTruthy();
    const stored = await readPrivateJson<Record<string, unknown>>(`users/${userId}.json`);
    expect(stored).toMatchObject({
      acceptedTsCsVersion: 1,
      acceptedTsCsIp: ip,
    });
    expect(typeof stored?.acceptedTsCsAt).toBe("string");
  });

  test("(2) register without acceptTsCs -> 400 TS_CS_NOT_ACCEPTED", async () => {
    const res = await invoke("authRegister", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: `int-no-tcs-${randomUUID()}@example.com`, password: PASSWORD },
    });

    expect(res.status).toBe(400);
    expect(res.jsonBody?.["code"]).toBe("TS_CS_NOT_ACCEPTED");
    expect(getSentEmails()).toHaveLength(0);
  });

  test("(3) register existing verified email -> 202 same shape; zero emails", async () => {
    const { user, credential } = await makeUser({ emailVerified: true });
    await writePrivateJson(`auth/${user.id}.json`, credential as AuthCredential);

    const res = await invoke("authRegister", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: {
        email: user.email,
        password: PASSWORD,
        acceptTsCs: true,
        acceptedTsCsVersion: 1,
      },
    });

    expect(res.status).toBe(202);
    expect(res.jsonBody).toMatchObject({ status: "accepted" });
    expect(getSentEmails()).toHaveLength(0);
  });

  test("(4) register existing unverified after >60s -> 202; new verification email re-sent", async () => {
    const { user } = await makeUser({ emailVerified: false });
    const staleToken = `stale-${randomUUID()}`;
    await seedStaleVerificationState(user.id, staleToken, 70_000);

    const res = await invoke("authRegister", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: {
        email: user.email,
        password: PASSWORD,
        acceptTsCs: true,
        acceptedTsCsVersion: 1,
      },
    });

    expect(res.status).toBe(202);
    const emails = getSentEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0]!.to).toEqual([user.email.toLowerCase()]);

    const newState = await readPrivateJson<VerificationState>(
      verificationStatePath(user.id),
    );
    expect(newState).toBeTruthy();
    expect(newState!.token).not.toBe(staleToken);
  });

  test("(5) verify(token) succeeds; verifying again -> 400 INVALID_TOKEN", async () => {
    const { user } = await makeUser({ emailVerified: false });
    const token = await generateShortLivedToken(user.id, "verify", 24);

    const first = await invoke("authVerifyEmail", {
      method: "GET",
      query: { token },
      headers: { "x-forwarded-for": uniqueIp() },
    });
    expect(first.status).toBe(200);

    const cred = await readPrivateJson<AuthCredential>(`auth/${user.id}.json`);
    expect(cred?.emailVerified).toBe(true);

    const second = await invoke("authVerifyEmail", {
      method: "GET",
      query: { token },
      headers: { "x-forwarded-for": uniqueIp() },
    });
    expect(second.status).toBe(400);
    expect(second.jsonBody?.["code"]).toBe("INVALID_TOKEN");
  });

  test("(6) verify(expired token) -> 400 INVALID_TOKEN; underlying blob untouched", async () => {
    const userId = randomUUID();
    const token = `expired-${randomUUID()}`;
    await seedExpiredVerifyToken(userId, token);

    const res = await invoke("authVerifyEmail", {
      method: "GET",
      query: { token },
      headers: { "x-forwarded-for": uniqueIp() },
    });
    expect(res.status).toBe(400);
    expect(res.jsonBody?.["code"]).toBe("INVALID_TOKEN");

    const tokenDoc = await readPrivateJson<AuthToken>(
      `auth/tokens/${sha256Hex(token)}.json`,
    );
    expect(tokenDoc).toBeTruthy();
    expect(tokenDoc?.consumed).toBeUndefined();
  });

  test("(7) login correct password -> 200 + tokens; failedAttempts reset to 0", async () => {
    const { user } = await makeUser({ emailVerified: true });
    await writePrivateJson(`auth/${user.id}.json`, {
      ...(await readPrivateJson<CredWithLockout>(`auth/${user.id}.json`))!,
      failedAttempts: [new Date(Date.now() - 1000).toISOString()],
      lockedUntil: null,
    });

    const res = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: PASSWORD },
    });

    expect(res.status).toBe(200);
    expect(res.jsonBody?.["accessToken"]).toEqual(expect.any(String));
    expect(res.jsonBody?.["refreshToken"]).toEqual(expect.any(String));

    const cred = await readPrivateJson<CredWithLockout>(`auth/${user.id}.json`);
    expect(cred?.failedAttempts).toEqual([]);
    expect(cred?.lockedUntil).toBeNull();
  });

  test("(8) login wrong password -> 401; failedAttempts increments; auth.token.reused NOT emitted", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await invoke("authLogin", {
        method: "POST",
        headers: { "x-forwarded-for": uniqueIp() },
        body: { email: user.email, password: "WrongPass123!" },
      });

      expect(res.status).toBe(401);

      const cred = await readPrivateJson<CredWithLockout>(`auth/${user.id}.json`);
      expect(cred?.failedAttempts?.length ?? 0).toBe(1);

      const reusedSeen = warnSpy.mock.calls
        .flat()
        .some((c) => String(c).includes("auth.token.reused"));
      expect(reusedSeen).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("(9) 5 wrong then 6th -> 423 ACCOUNT_LOCKED; after >15min clock advance, correct succeeds", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const baseTime = new Date("2026-01-01T12:00:00Z");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(baseTime);
    const ip = uniqueIp();

    for (let i = 0; i < 5; i++) {
      const res = await invoke("authLogin", {
        method: "POST",
        headers: { "x-forwarded-for": ip },
        body: { email: user.email, password: "WrongPass123!" },
      });
      expect(res.status).toBe(401);
    }

    const locked = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: { email: user.email, password: "WrongPass123!" },
    });
    expect(locked.status).toBe(423);
    expect(locked.jsonBody?.["code"]).toBe("ACCOUNT_LOCKED");

    const stillLocked = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: { email: user.email, password: PASSWORD },
    });
    expect(stillLocked.status).toBe(423);

    vi.setSystemTime(new Date(baseTime.getTime() + 16 * 60_000));
    resetAllBuckets();

    const recovered = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: { email: user.email, password: PASSWORD },
    });
    expect(recovered.status).toBe(200);
  });

  test("(10) refresh(valid token) -> new access token; refresh remains usable", async () => {
    const { user } = await makeUser({ emailVerified: true });

    const login = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: PASSWORD },
    });
    expect(login.status).toBe(200);
    const refreshToken = String(login.jsonBody?.["refreshToken"]);

    const first = await invoke("authRefresh", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { refreshToken },
    });
    expect(first.status).toBe(200);
    expect(first.jsonBody?.["accessToken"]).toEqual(expect.any(String));

    const second = await invoke("authRefresh", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { refreshToken },
    });
    expect(second.status).toBe(200);
    expect(second.jsonBody?.["accessToken"]).toEqual(expect.any(String));
  });

  test("(11) forgot-password silent shape; one email if user exists, zero if not", async () => {
    const { user } = await makeUser({ emailVerified: true });

    const exists = await invoke("authForgotPassword", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email },
    });
    expect(exists.status).toBe(200);
    expect(getSentEmails()).toHaveLength(1);

    clearSentEmails();
    const missing = await invoke("authForgotPassword", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: `nobody-${randomUUID()}@example.com` },
    });
    expect(missing.status).toBe(200);
    expect(missing.jsonBody).toEqual(exists.jsonBody);
    expect(getSentEmails()).toHaveLength(0);
  });

  test("(12) reset-password updates credential; old password no longer works", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const resetToken = await generateShortLivedToken(user.id, "reset", 1);
    const newPassword = "BrandNewPass456!";

    const reset = await invoke("authResetPassword", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { token: resetToken, newPassword },
    });
    expect(reset.status).toBe(200);

    const oldLogin = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: PASSWORD },
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: newPassword },
    });
    expect(newLogin.status).toBe(200);
  });

  test("(13) reset-password same token twice in parallel -> exactly 1 success, 1 INVALID_TOKEN", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const resetToken = await generateShortLivedToken(user.id, "reset", 1);

    const [a, b] = await Promise.all([
      invoke("authResetPassword", {
        method: "POST",
        headers: { "x-forwarded-for": uniqueIp() },
        body: { token: resetToken, newPassword: "ParallelOne123!" },
      }),
      invoke("authResetPassword", {
        method: "POST",
        headers: { "x-forwarded-for": uniqueIp() },
        body: { token: resetToken, newPassword: "ParallelTwo123!" },
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    const failed = [a, b].find((r) => r.status === 400)!;
    expect(failed.jsonBody?.["code"]).toBe("INVALID_TOKEN");
  });

  test("(14) register burst: 4th call from same IP -> 429 RATE_LIMITED + Retry-After header", async () => {
    const ip = uniqueIp();
    resetAllBuckets();

    for (let i = 0; i < 3; i++) {
      const ok = await invoke("authRegister", {
        method: "POST",
        headers: { "x-forwarded-for": ip },
        body: {
          email: `burst-${i}-${randomUUID()}@example.com`,
          password: PASSWORD,
          acceptTsCs: true,
          acceptedTsCsVersion: 1,
        },
      });
      expect(ok.status).toBe(202);
    }

    const fourth = await invoke("authRegister", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: {
        email: `burst-4-${randomUUID()}@example.com`,
        password: PASSWORD,
        acceptTsCs: true,
        acceptedTsCsVersion: 1,
      },
    });

    expect(fourth.status).toBe(429);
    expect(fourth.jsonBody?.["code"]).toBe("RATE_LIMITED");
    expect(fourth.headers?.["Retry-After"]).toBeDefined();
  });
});
