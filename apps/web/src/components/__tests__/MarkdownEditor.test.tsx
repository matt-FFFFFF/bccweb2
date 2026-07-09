// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { MarkdownEditor } from "../MarkdownEditor.js";

describe("MarkdownEditor", () => {
  test("renders fallback initially", () => {
    const { container } = render(<MarkdownEditor value="hello" onChange={() => {}} />);
    expect(container.querySelector("textarea")).not.toBeNull();
  });
});
