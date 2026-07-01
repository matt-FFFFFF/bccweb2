import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import SignToFly from "../SignToFly.js";
import { api, ApiError } from "../../../lib/api.js";
import { XSS_CORPUS } from "../../../../../../tests/fixtures/xss-corpus.js";

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

describe("SignToFly", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  const renderComponent = (path = "/rounds/r1/sign/t1/1") => {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/rounds/:roundId/sign/:teamId/:place" element={<SignToFly />} />
        </Routes>
      </MemoryRouter>
    );
  };

  it("renders wording markdown and pilot context", async () => {
    vi.mocked(api.get).mockImplementation(async (url) => {
      if (url === "sign-to-fly/wording/active") {
        return { markdown: "Safety **Briefing**" };
      }
      if (url === "rounds/r1/brief") {
        return { 
          version: 2, 
          teams: [{ teamName: "Test Team", pilots: [{ placeInTeam: 1, name: "John Doe" }] }] 
        };
      }
      if (url === "rounds/r1") {
        return {
          id: "r1",
          date: "2023-01-01T00:00:00.000Z",
          teams: [{ id: "t1", teamName: "Test Team", pilots: [{ placeInTeam: 1, pilotId: "p1" }] }]
        };
      }
      return null;
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/John Doe/)).toBeInTheDocument();
    });

    expect(screen.getByText(/Test Team/)).toBeInTheDocument();
    expect(screen.getByText(/Briefing/).tagName).toBe("STRONG");
  });

  it("neutralizes XSS payloads", async () => {
    vi.mocked(api.get).mockImplementation(async (url) => {
      if (url === "sign-to-fly/wording/active") {
        return { markdown: "**Bold** " + XSS_CORPUS.join(" ") };
      }
      if (url === "rounds/r1/brief") {
        return { teams: [] };
      }
      if (url === "rounds/r1") {
        return { id: "r1", date: "2023-01-01T00:00:00.000Z", teams: [] };
      }
      return null;
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Bold").tagName).toBe("STRONG");
    });

    const html = document.body.innerHTML;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onload");
    expect(html).not.toContain("onmouseover");
  });

  it("submit disabled until checkbox checked", async () => {
    vi.mocked(api.get).mockImplementation(async (url) => {
      if (url === "sign-to-fly/wording/active") return { markdown: "Text" };
      if (url === "rounds/r1/brief") return { teams: [] };
      if (url === "rounds/r1") return { id: "r1", date: "2023-01-01T00:00:00.000Z", teams: [] };
      return null;
    });

    renderComponent();

    const button = await screen.findByRole("button", { name: "Sign to Fly" });
    expect(button).toBeDisabled();

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);

    expect(button).toBeEnabled();
  });

  it("happy submit -> confirmation card with signedAt + versions", async () => {
    vi.mocked(api.get).mockImplementation(async (url) => {
      if (url === "sign-to-fly/wording/active") return { markdown: "Text" };
      if (url === "rounds/r1/brief") return { teams: [] };
      if (url === "rounds/r1") return { id: "r1", date: "2023-01-01T00:00:00.000Z", teams: [] };
      return null;
    });

    vi.mocked(api.post).mockResolvedValueOnce({
      signedAt: "2023-01-02T10:00:00.000Z",
      briefVersion: 3,
      wordingVersion: 5
    });

    renderComponent();

    const checkbox = await screen.findByRole("checkbox");
    fireEvent.click(checkbox);

    const button = screen.getByRole("button", { name: "Sign to Fly" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Signed Successfully")).toBeInTheDocument();
    });

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("403 NOT_YOUR_SLOT -> human-readable message", async () => {
    vi.mocked(api.get).mockRejectedValueOnce(
      new ApiError(403, "NOT_YOUR_SLOT", "Not your slot", "req-1", "Detail")
    );

    renderComponent();

    expect(await screen.findByText("This slot is not yours — sign-to-fly is for the pilot assigned to slot 1.")).toBeInTheDocument();
  });

  it("409 INVALID_STATE -> not-ready message", async () => {
    vi.mocked(api.get).mockRejectedValueOnce(
      new ApiError(409, "INVALID_STATE", "Invalid state", "req-2", "Missing brief")
    );

    renderComponent();

    expect(await screen.findByText("This round is not yet ready for sign-to-fly. The briefing has to be marked complete first. Current status: Missing brief.")).toBeInTheDocument();
  });

  it("renders briefing summary prose as markdown and literal for non-prose", async () => {
    vi.mocked(api.get).mockImplementation(async (url) => {
      if (url === "sign-to-fly/wording/active") {
        return { markdown: "Text" };
      }
      if (url === "rounds/r1/brief") {
        return { 
          version: 2, 
          teams: [],
          airspaceAndHazards: "**A** " + XSS_CORPUS.join(" "),
          expectedLandingArea: "**B**",
          briefersNotes: "**C**",
          windSpeedDirection: "**x**",
        };
      }
      if (url === "rounds/r1") {
        return {
          id: "r1",
          date: "2023-01-01T00:00:00.000Z",
          teams: [{ id: "t1", teamName: "Test Team", pilots: [{ placeInTeam: 1, pilotId: "p1" }] }]
        };
      }
      return null;
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("A").tagName).toBe("STRONG");
    });

    expect(screen.getByText("B").tagName).toBe("STRONG");
    expect(screen.getByText("C").tagName).toBe("STRONG");
    expect(screen.getByText("**x**")).toBeInTheDocument();

    const html = document.body.innerHTML;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror");
  });

});
