import { describe, expect, it } from "vitest";
import { sanitizeWordingHtml } from "../sanitize.js";

describe("sanitizeWordingHtml", () => {
  it("strips script tags", () => {
    const output = sanitizeWordingHtml("<p>safe</p><script>alert(1)</script>");
    expect(output).toContain("<p>safe</p>");
    expect(output).not.toContain("<script>");
    expect(output).not.toContain("alert");
  });

  it("preserves strong formatting", () => {
    expect(sanitizeWordingHtml("<strong>bold</strong>")).toContain("<strong>bold</strong>");
  });

  it("drops unsupported links", () => {
    expect(sanitizeWordingHtml('<a href="https://example.com">link</a>')).toBe("link");
  });

  it("strips javascript hrefs", () => {
    const output = sanitizeWordingHtml('<a href="javascript:alert(1)">bad</a>');
    expect(output).not.toContain("javascript:");
    expect(output).toContain("bad");
  });

  it("strips event handler attributes", () => {
    const output = sanitizeWordingHtml('<p onclick="alert(1)">click</p>');
    expect(output).toContain("<p>click</p>");
    expect(output).not.toContain("onclick");
  });

  it("preserves list markup", () => {
    expect(sanitizeWordingHtml("<ul><li>One</li><li>Two</li></ul>")).toContain("<ul><li>One</li><li>Two</li></ul>");
  });
});
