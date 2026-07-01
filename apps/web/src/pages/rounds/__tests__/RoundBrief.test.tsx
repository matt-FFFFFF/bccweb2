import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import RoundBrief from "../RoundBrief.js";
import { XSS_CORPUS } from "../../../../../../tests/fixtures/xss-corpus.js";
import { api } from "../../../lib/api.js";


vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: () => ({
    identity: {
      userId: "u1",
      email: "test@example.com",
      roles: ["Pilot"],
      pilotId: "p1",
      clubId: "c1",
    },
    loading: false,
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  loginUrl: vi.fn(),
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

describe("RoundBrief", () => {

  beforeEach(() => {
    vi.resetAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        roundId: "r1",
        version: 1,
        generatedAt: "2023-01-01T00:00:00.000Z",
        teams: [],
        airspaceAndHazards: "**A** " + XSS_CORPUS.join(" "),
        expectedLandingArea: "**B**",
        briefersNotes: "**C**",
        windSpeedDirection: "**x**"
      })
    });
  });


  afterEach(() => {
    cleanup();
  });

  const renderComponent = () => {
    return render(
      <MemoryRouter initialEntries={["/rounds/r1/brief"]}>
        <Routes>
          <Route path="/rounds/:id/brief" element={<RoundBrief />} />
        </Routes>
      </MemoryRouter>
    );
  };

  it("renders prose fields as markdown and neutralizes XSS payloads", async () => {
    vi.mocked(api.get).mockResolvedValue({
      roundId: "r1",
      version: 1,
      generatedAt: "2023-01-01T00:00:00.000Z",
      teams: [],
      airspaceAndHazards: "**A** " + XSS_CORPUS.join(" "),
      expectedLandingArea: "**B**",
      briefersNotes: "**C**",
      windSpeedDirection: "**x**", // Non-prose should be literal
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("A").tagName).toBe("STRONG");
      expect(screen.getByText("B").tagName).toBe("STRONG");
      expect(screen.getByText("C").tagName).toBe("STRONG");
    });

    const html = document.body.innerHTML;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror");

    expect(screen.getByText("**x**")).toBeInTheDocument();
  });
});
