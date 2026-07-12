// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import "../../__tests__/setup.ts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Banner } from "../Banner.js";

describe("Banner live regions", () => {
  it("announces errors assertively", () => {
    render(<Banner msg="Failed to save" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to save");
  });

  it("announces success politely", () => {
    render(<Banner msg="Saved" ok />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });
});
