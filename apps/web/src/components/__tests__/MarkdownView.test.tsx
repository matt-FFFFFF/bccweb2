// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { MarkdownView } from "../MarkdownView.js";
import { XSS_CORPUS } from "../../../../../tests/fixtures/xss-corpus.js";

describe("MarkdownView", () => {
  test("neutralises every payload in XSS_CORPUS", () => {
    XSS_CORPUS.forEach((payload) => {
      const { container } = render(<MarkdownView markdown={payload} />);
      // No scripts, iframes, on* handlers, or javascript: urls should survive
      expect(container.querySelector("script")).toBeNull();
      expect(container.querySelector("iframe")).toBeNull();
      
      const allElements = container.querySelectorAll("*");
      allElements.forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
          expect(attr.name.toLowerCase()).not.toMatch(/^on/);
          expect(attr.value.toLowerCase()).not.toMatch(/^javascript:/);
        });
      });
    });
  });

  test("renders '<iframe src=\"javascript:alert(1)\"></iframe>' without iframe", () => {
    const { container } = render(<MarkdownView markdown={'<iframe src="javascript:alert(1)"></iframe>'} />);
    expect(container.querySelector("iframe")).toBeNull();
  });

  test("renders positive format: **x**, - a, # h", () => {
    const markdown = `
# Heading
**bold**
- list item
    `;
    const { container } = render(<MarkdownView markdown={markdown} />);
    expect(container.querySelector("h1")).not.toBeNull();
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector("li")).not.toBeNull();
  });
});
