// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import "../../../__tests__/setup.ts";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, it, expect, vi, afterEach } from "vitest";
import RoundManage from "../RoundManage.js";
import { api, ApiError } from "../../../lib/api.js";

vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: () => ({
    loading: false,
    identity: { id: "u1", roles: ["Admin"] },
    isRefreshing: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useBlob.js", () => ({
  useBlob: () => ({ data: null, loading: false, error: null, notFound: false }),
}));

vi.mock("../../../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/api.js")>("../../../lib/api.js");
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  };
});

describe("RoundManage error handling", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("runAction surfaces ApiError.detail when an action fails", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.endsWith("/brief")) return { pdfStatus: "failed" };
      return { id: "round-1", site: { name: "Site" }, season: { year: 2026 }, teams: [], brief: { pdfStatus: "failed" }, status: "Locked", isLocked: true };
    });
    
    vi.mocked(api.post).mockRejectedValueOnce(
      new ApiError(409, "Conflict", "Conflict", undefined, "Wait 12 minutes before recreating")
    );

    render(
      <MemoryRouter initialEntries={["/rounds/round-1/manage"]}>
        <Routes>
          <Route path="/rounds/:id/manage" element={<RoundManage />} />
        </Routes>
      </MemoryRouter>
    );
    
    const btn = await screen.findByRole("button", { name: "Regenerate PDF" });
    fireEvent.click(btn);
    
    await waitFor(() => {
      expect(screen.getByText("Wait 12 minutes before recreating")).toBeInTheDocument();
    });
  });
});
