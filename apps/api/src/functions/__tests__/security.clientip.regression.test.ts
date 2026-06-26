import { describe, expect, test, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { getRegisteredHandler, clearSentEmails } from "../../__tests__/helpers/setup.js";
import { makeRequest } from "../../__tests__/helpers/api.js";
import { readPrivateJson } from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import "../authFunctions.js";

interface HandlerResponse {
  status?: number;
  headers?: Record<string, string>;
  jsonBody?: Record<string, unknown>;
}

function ctxStub() {
  return {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    invocationId: "reg",
    functionName: "reg",
  } as never;
}

async function invoke(
  handlerName: string,
  init: { method?: string; body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<HandlerResponse> {
  const entry = getRegisteredHandler(handlerName);
  if (!entry) throw new Error(`Handler "${handlerName}" not registered`);
  const req = makeRequest({ method: init.method, body: init.body, query: init.query, headers: init.headers });
  return (await entry.handler(req as never, ctxStub())) as HandlerResponse;
}

beforeEach(() => {
  resetAllBuckets();
  clearSentEmails();
});

describe("client-IP spoofing regression (#72/#73)", () => {
  test("rotating client-controlled headers does NOT bypass the per-IP rate limit", async () => {
    const victim = "victim@example.com";
    const trustedHop = "203.0.113.10";
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await invoke("authForgotPassword", {
        method: "POST",
        headers: {
          "x-azure-clientip": `203.0.113.${100 + i}`,
          "x-forwarded-for": `203.0.113.${200 + i}, ${trustedHop}`,
        },
        body: { email: victim },
      });
      statuses.push(res.status ?? 0);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses).toContain(429);
  });

  test("a forged x-azure-clientip is NOT persisted as acceptedTsCsIp; the trusted hop is", async () => {
    const email = `reg-${randomUUID()}@example.com`;
    const forged = "203.0.113.231";
    const trustedHop = "198.51.100.7";

    const res = await invoke("authRegister", {
      method: "POST",
      headers: { "x-azure-clientip": forged, "x-forwarded-for": `10.0.0.9, ${trustedHop}` },
      body: { email, password: "TestPass123!", acceptTsCs: true, acceptedTsCsVersion: 1 },
    });
    expect(res.status).toBe(202);

    const index = await readPrivateJson<Record<string, string>>("user-index.json");
    const userId = index![email.toLowerCase()];
    expect(userId).toBeTruthy();
    const stored = await readPrivateJson<Record<string, unknown>>(`users/${userId}.json`);
    expect(stored?.["acceptedTsCsIp"]).toBe(trustedHop);
    expect(stored?.["acceptedTsCsIp"]).not.toBe(forged);
  });
});
