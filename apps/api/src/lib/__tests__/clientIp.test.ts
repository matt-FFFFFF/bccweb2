import { describe, expect, test } from "vitest";
import type { HttpRequest } from "@azure/functions";
import { trustedClientIp } from "../clientIp.js";

function reqWith(headers: Record<string, string>): HttpRequest {
  return { headers: new Headers(headers) } as unknown as HttpRequest;
}

describe("trustedClientIp", () => {
  test("uses the right-most XFF entry (the platform-appended socket IP)", () => {
    expect(
      trustedClientIp(reqWith({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.9" })),
    ).toBe("203.0.113.9");
  });

  test("ignores client-prepended spoofed entries to the left", () => {
    expect(trustedClientIp(reqWith({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  test("does NOT trust a client-supplied x-azure-clientip", () => {
    expect(
      trustedClientIp(reqWith({ "x-azure-clientip": "9.9.9.9", "x-forwarded-for": "6.6.6.6, 203.0.113.9" })),
    ).toBe("203.0.113.9");
  });

  test("strips the port from the right-most entry", () => {
    expect(trustedClientIp(reqWith({ "x-forwarded-for": "203.0.113.9:54321" }))).toBe("203.0.113.9");
  });

  test("handles a bracketed IPv6 right-most entry", () => {
    expect(trustedClientIp(reqWith({ "x-forwarded-for": "[2001:db8::1]:443" }))).toBe("2001:db8::1");
  });

  test("uses a single XFF entry as-is", () => {
    expect(trustedClientIp(reqWith({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  test("returns null when no X-Forwarded-For is present (x-azure-clientip not trusted)", () => {
    expect(trustedClientIp(reqWith({ "x-azure-clientip": "9.9.9.9" }))).toBeNull();
  });

  test("returns null for an empty X-Forwarded-For header", () => {
    expect(trustedClientIp(reqWith({ "x-forwarded-for": "" }))).toBeNull();
  });
});
