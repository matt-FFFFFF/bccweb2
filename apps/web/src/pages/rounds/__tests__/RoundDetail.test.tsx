import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import RoundDetail from "../RoundDetail.js";
import { api } from "../../../lib/api.js";
import { useBlob } from "../../../hooks/useBlob.js";
import { useAuth } from "../../../hooks/useAuth.js";
import type { Round, RoundBrief } from "@bccweb/types";

vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: vi.fn(),
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  loginUrl: vi.fn(),
}));

vi.mock("../../../hooks/useBlob.js", () => ({
  useBlob: vi.fn(),
}));

vi.mock("../../../lib/api.js", async () => {
  const actual = await vi.importActual("../../../lib/api.js");
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
    },
  };
});

describe("RoundDetail", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(useAuth).mockReturnValue({
      identity: {
        userId: "u1",
        email: "test@example.com",
        roles: ["Pilot"],
        pilotId: "p1",
        clubId: "c1",
      },
      loading: false,
      logout: vi.fn(),
    } as ReturnType<typeof useAuth>);
    vi.mocked(useBlob).mockReturnValue({
      data: [],
      loading: false,
      error: null,
      notFound: false,
    } as ReturnType<typeof useBlob>);
  });

  afterEach(() => {
    cleanup();
  });

  it("sanitizes round narrative before rendering", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "rounds/r1") {
        return {
          id: "r1",
          date: "2026-06-11",
          status: "Confirmed",
          isLocked: false,
          maxTeams: 2,
          minimumScore: 0,
          site: { id: "s1", name: "Llangollen" },
          season: { year: 2026 },
          teams: [],
          narrative: '<p>Safe text</p><script>alert(1)</script><img src="x" onerror="alert(1)">',
        } as Round;
      }

      return {
        roundId: "r1",
        version: 1,
        generatedAt: "2023-01-01T00:00:00.000Z",
        teams: [],
      } as RoundBrief;
    });

    render(
      <MemoryRouter initialEntries={["/rounds/r1"]}>
        <Routes>
          <Route path="/rounds/:id" element={<RoundDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Safe text")).toBeInTheDocument();
    });

    const html = document.body.innerHTML;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror");
  });
});
