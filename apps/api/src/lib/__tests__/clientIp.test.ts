import { describe, expect, test } from "vitest";
import type { HttpRequest } from "@azure/functions";
import { trustedClientIp } from "../clientIp.js";

function reqWith(headers: Record<string, string>): HttpRequest {
  return { headers: new Headers(headers) } as unknown as HttpRequest;
}

describe("trustedClientIp", () => {
  test("prefers x-azure-clientip over X-Forwarded-For", () => {
    expect(
      trustedClientIp(reqWith({ "x-azure-clientip": "9.9.9.9", "x-forwarded-for": "1.1.1.1, 2.2.2.2" })),
    ).toBe("9.9.9.9");
  });

  test("ignores a spoofed XFF entry when the platform IP is present", () => {
    expect(
      trustedClientIp(reqWith({ "x-azure-clientip": "9.9.9.9", "x-forwarded-for": "6.6.6.6" })),
    ).toBe("9.9.9.9");
  });

  test("falls back to the first XFF entry when no platform IP (local/dev)", () => {
    expect(trustedClientIp(reqWith({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("1.1.1.1");
  });

  test("trims the XFF entry", () => {
    expect(trustedClientIp(reqWith({ "x-forwarded-for": "  1.1.1.1  , 2.2.2.2" }))).toBe("1.1.1.1");
  });

  test("returns null when neither header is present", () => {
    expect(trustedClientIp(reqWith({}))).toBeNull();
  });

  test("returns null for an empty XFF header", () => {
    expect(trustedClientIp(reqWith({ "x-forwarded-for": "" }))).toBeNull();
  });
});
