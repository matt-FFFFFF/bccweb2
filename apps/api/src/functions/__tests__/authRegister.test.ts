import crypto from "crypto";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeRequest } from "../../__tests__/helpers/api.js";
import { makeUser, writePrivateJson } from "../../__tests__/helpers/seed.js";
import type { AuthCredential } from "../../lib/authHelpers.js";
import { sendEmail } from "../../lib/email.js";
import "../authFunctions.js";

const registerResponse = {
  status: "accepted",
  message:
    "If this email is not yet registered, you will receive a verification link shortly.",
};

function verificationStatePath(userId: string): string {
  return `auth/verification-state/${userId}.json`;
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function seedFreshVerificationState(userId: string, token = "fresh-verification-token") {
  const createdAt = new Date().toISOString();
  await writePrivateJson(verificationStatePath(userId), {
    token,
    createdAt,
    expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
  });
  await writePrivateJson(`auth/tokens/${tokenHash(token)}.json`, {
    userId,
    type: "verify",
    createdAt,
    expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
  });
}

describe("auth register enumeration neutralization", () => {
  beforeEach(() => {
    vi.mocked(sendEmail).mockClear();
  });

  test("register with new email: 202 + verification email sent", async () => {
    const entry = getRegisteredHandler("authRegister");
    expect(entry).toBeTruthy();

    const email = `new-${Date.now()}@example.com`;
    const req = makeRequest({
      method: "POST",
      body: { email, password: "TestPass123!" },
    });

    const res = await entry!.handler(req as never, { log: () => undefined } as never);

    expect(res.status).toBe(202);
    expect(res.jsonBody).toEqual(registerResponse);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
  });

  test("register with existing unverified email: 202 + email re-sent", async () => {
    const { user } = await makeUser({ emailVerified: false });
    await seedFreshVerificationState(user.id);

    const entry = getRegisteredHandler("authRegister");
    expect(entry).toBeTruthy();

    const req = makeRequest({
      method: "POST",
      body: { email: user.email, password: "TestPass123!" },
    });

    const res = await entry!.handler(req as never, { log: () => undefined } as never);

    expect(res.status).toBe(202);
    expect(res.jsonBody).toEqual(registerResponse);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
  });

  test("register with existing verified email: 202 + zero emails sent", async () => {
    const { user, credential } = await makeUser({ emailVerified: true });
    await writePrivateJson(`auth/${user.id}.json`, credential as AuthCredential);

    const entry = getRegisteredHandler("authRegister");
    expect(entry).toBeTruthy();

    const req = makeRequest({
      method: "POST",
      body: { email: user.email, password: "TestPass123!" },
    });

    const res = await entry!.handler(req as never, { log: () => undefined } as never);

    expect(res.status).toBe(202);
    expect(res.jsonBody).toEqual(registerResponse);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(0);
  });

  test("register response body identical across all three branches", async () => {
    const entry = getRegisteredHandler("authRegister");
    expect(entry).toBeTruthy();

    const newEmail = `shape-new-${Date.now()}@example.com`;
    const { user: unverifiedUser } = await makeUser({ emailVerified: false });
    await seedFreshVerificationState(unverifiedUser.id, "fresh-token-shape");
    const { user: verifiedUser } = await makeUser({ emailVerified: true });

    const responses = [] as unknown[];

    responses.push(
      (await entry!.handler(
        makeRequest({ method: "POST", body: { email: newEmail, password: "TestPass123!" } }) as never,
        { log: () => undefined } as never,
      )).jsonBody,
    );
    responses.push(
      (await entry!.handler(
        makeRequest({ method: "POST", body: { email: unverifiedUser.email, password: "TestPass123!" } }) as never,
        { log: () => undefined } as never,
      )).jsonBody,
    );
    responses.push(
      (await entry!.handler(
        makeRequest({ method: "POST", body: { email: verifiedUser.email, password: "TestPass123!" } }) as never,
        { log: () => undefined } as never,
      )).jsonBody,
    );

    expect(responses[0]).toEqual(responses[1]);
    expect(responses[1]).toEqual(responses[2]);
  });
});
