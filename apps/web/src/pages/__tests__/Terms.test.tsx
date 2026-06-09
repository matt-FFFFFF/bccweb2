import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Terms from "../Terms.js";

describe("Terms", () => {
  it("renders Terms heading", () => {
    render(<Terms />);
    expect(screen.getByRole("heading", { name: /Terms & Conditions/i })).toBeInTheDocument();
  });

  it("version footer present", () => {
    render(<Terms />);
    expect(screen.getAllByText(/Terms version: 1/)[0]).toBeInTheDocument();
  });
});
