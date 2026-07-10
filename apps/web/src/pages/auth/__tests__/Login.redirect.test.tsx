// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { describe, expect, it, vi } from "vitest";
import Login from "../Login.js";

vi.mock("../../../hooks/useAuth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../hooks/useAuth.js")>();
  return {
    ...actual,
    useAuth: () => ({
      login: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn(),
      refreshIdentity: vi.fn(),
      identity: null,
      loading: false,
      isRefreshing: false
    })
  };
});

vi.mock("../../../lib/api.js", () => ({
  api: {
    post: vi.fn()
  }
}));

describe("Login redirect behavior", () => {
  it("redirects to home and ignores ?return= param", async () => {
    render(
      <MemoryRouter initialEntries={["/login?return=%2Fadmin%2Fclubs"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<div>HOME_SENTINEL</div>} />
          <Route path="/admin/clubs" element={<div>ADMINCLUBS_SENTINEL</div>} />
        </Routes>
      </MemoryRouter>
    );

    const emailInput = screen.getByLabelText("Email address");
    const passwordInput = screen.getByLabelText("Password");
    const submitBtn = screen.getByRole("button", { name: "Sign in" });

    fireEvent.change(emailInput, { target: { value: "test@example.com" } });
    fireEvent.change(passwordInput, { target: { value: "password123" } });
    fireEvent.click(submitBtn);

    expect(await screen.findByText("HOME_SENTINEL")).toBeInTheDocument();
    expect(screen.queryByText("ADMINCLUBS_SENTINEL")).toBeNull();
  });
});
