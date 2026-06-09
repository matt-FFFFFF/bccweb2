import { describe, expect, test, vi, beforeEach } from "vitest";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeRequest } from "../../__tests__/helpers/api.js";
import { readPrivateJson } from "../../__tests__/helpers/seed.js";
import { sendEmail } from "../../lib/email.js";
import "../authFunctions.js";

describe("auth register TsCs", () => {
  beforeEach(() => {
    vi.mocked(sendEmail).mockClear();
  });

  test("register WITHOUT acceptTsCs: true -> 400 TS_CS_NOT_ACCEPTED", async () => {
    const entry = getRegisteredHandler("authRegister");
    expect(entry).toBeTruthy();

    const res = await entry!.handler(
      makeRequest({ method: "POST", body: { email: "nope@example.com", password: "TestPass123!" } }) as never,
      { log: () => undefined } as never,
    );

    expect(res.status).toBe(400);
    expect(res.jsonBody).toMatchObject({ code: "TS_CS_NOT_ACCEPTED" });
  });

  test("register with acceptTsCs: true + acceptedTsCsVersion=1 -> 202; user blob has acceptedTsCsAt/IP/Version persisted", async () => {
    const entry = getRegisteredHandler("authRegister");
    expect(entry).toBeTruthy();

    const email = `tscs-${Date.now()}@example.com`;
    const emailLower = email.toLowerCase();
    const res = await entry!.handler(
      makeRequest({
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.9" },
        body: { email, password: "TestPass123!", acceptTsCs: true, acceptedTsCsVersion: 1 },
      }) as never,
      { log: () => undefined } as never,
    );

    expect(res.status).toBe(202);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);

    const userIndex = await readPrivateJson<Record<string, string>>("user-index.json");
    const userId = userIndex![emailLower];
    expect(userId).toBeTruthy();
    const stored = await readPrivateJson<Record<string, unknown>>(`users/${userId}.json`);
    expect(stored).toMatchObject({
      acceptedTsCsVersion: 1,
      acceptedTsCsIp: "203.0.113.9",
    });
    expect(typeof stored?.acceptedTsCsAt).toBe("string");
  });
});
