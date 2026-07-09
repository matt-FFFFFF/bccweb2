// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import Register from "../Register.js";

vi.mock("../../../lib/api.js", () => ({
  api: { post: vi.fn() },
}));

describe("Register TsCs", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => cleanup());

  it("submit disabled until acceptTsCs checked", () => {
    render(<MemoryRouter><Register /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();
  });

  it("checkbox link points to /terms", () => {
    render(<MemoryRouter><Register /></MemoryRouter>);
    expect(screen.getAllByRole("link", { name: /Terms & Conditions/ })[0]).toHaveAttribute("href", "/terms");
  });

  it("successful submit calls api.post with acceptTsCs: true and acceptedTsCsVersion", async () => {
    const { api } = await import("../../../lib/api.js");
    vi.mocked(api.post).mockResolvedValueOnce(undefined as never);
    render(<MemoryRouter><Register /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(/Email address/i), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText(/^Password/i), { target: { value: "TestPass123!" } });
    fireEvent.change(screen.getByLabelText(/Confirm password/i), { target: { value: "TestPass123!" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(api.post).toHaveBeenCalledWith("auth/register", expect.objectContaining({ acceptTsCs: true, acceptedTsCsVersion: 1 }));
  });
});
