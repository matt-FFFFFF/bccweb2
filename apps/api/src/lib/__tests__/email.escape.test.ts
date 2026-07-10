// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { beforeAll, describe, expect, test, vi } from "vitest";

let email: typeof import("../email.js");

beforeAll(async () => {
  email = await vi.importActual<typeof import("../email.js")>("../email.js");
});

describe("email template HTML escaping", () => {
  test("briefHtmlBody escapes the site name", () => {
    const html = email.briefHtmlBody("<script>alert(1)</script>", "2026-06-15");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("verificationEmailHtml escapes the verify URL (attribute + text)", () => {
    const html = email.verificationEmailHtml('https://x/verify?token=a"&b=<i>');
    expect(html).not.toContain('token=a"&b=<i>');
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;i&gt;");
  });

  test("passwordResetEmailHtml escapes the reset URL", () => {
    const html = email.passwordResetEmailHtml('https://x/reset?token=a"><img src=x>');
    expect(html).not.toContain('"><img');
    expect(html).toContain("&quot;");
    expect(html).toContain("&gt;");
  });
});
