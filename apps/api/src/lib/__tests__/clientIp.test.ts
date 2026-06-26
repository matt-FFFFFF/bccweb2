import { describe, expect, test } from "vitest";
import type { HttpRequest } from "@azure/functions";
import { trustedClientIp } from "../clientIp.js";

function reqWith(headers: Record<string, string>): HttpRequest {
  return { headers: new Headers(headers) } as unknown as HttpRequest;
}

describe("trustedClientIp", () => {
  test("prefers the platform-set client-ip header (port-stripped)", () => {
    expect(
      trustedClientIp(reqWith({ "client-ip": "82.71.50.1:60848", "x-forwarded-for": "6.6.6.6", "x-azure-clientip": "9.9.9.9" })),
    ).toBe("82.71.50.1");
  });

  test("does NOT use a forged x-azure-clientip or left-most XFF when client-ip is set", () => {
    expect(
      trustedClientIp(reqWith({ "client-ip": "82.71.50.1", "x-azure-clientip": "203.0.113.7", "x-forwarded-for": "203.0.113.8, 1.2.3.4" })),
    ).toBe("82.71.50.1");
  });

  test("falls back to the right-most XFF hop when client-ip is absent (local/dev)", () => {
    expect(trustedClientIp(reqWith({ "x-forwarded-for": "203.0.113.8, 82.71.50.1" }))).toBe("82.71.50.1");
  });

  test("does NOT trust x-azure-clientip", () => {
    expect(trustedClientIp(reqWith({ "x-azure-clientip": "203.0.113.7" }))).toBeNull();
  });

  test("strips the port from client-ip and the XFF fallback", () => {
    expect(trustedClientIp(reqWith({ "client-ip": "82.71.50.1:60848" }))).toBe("82.71.50.1");
    expect(trustedClientIp(reqWith({ "x-forwarded-for": "82.71.50.1:60846" }))).toBe("82.71.50.1");
  });

  test("handles a bracketed IPv6 client-ip", () => {
    expect(trustedClientIp(reqWith({ "client-ip": "[2001:db8::1]:443" }))).toBe("2001:db8::1");
  });

  test("returns null when neither client-ip nor X-Forwarded-For is present", () => {
    expect(trustedClientIp(reqWith({ "x-azure-clientip": "9.9.9.9" }))).toBeNull();
  });

  test("returns null for an empty X-Forwarded-For header", () => {
    expect(trustedClientIp(reqWith({ "x-forwarded-for": "" }))).toBeNull();
  });
});
