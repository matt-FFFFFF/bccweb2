import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import PilotProfile from "../PilotProfile.js";
import { api, ApiError } from "../../../lib/api.js";
import type { Pilot, PilotClubMembership } from "@bccweb/types";

vi.mock("../../../lib/api.js", async () => {
  const actual = await vi.importActual("../../../lib/api.js");
  return {
    ...actual,
    api: {
      get: vi.fn(),
      put: vi.fn(),
    },
  };
});

vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: () => ({
    identity: {
      userId: "u1",
      email: "pilot@example.com",
      roles: ["Pilot"],
      pilotId: "pilot-123",
      clubId: null,
    },
    loading: false,
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  loginUrl: vi.fn(),
}));

const mockPilot: Pilot = {
  id: "pilot-123",
  legacyId: null,
  coachType: "None",
  pilotRating: "Pilot",
  person: {
    id: "person-1",
    firstName: "Test",
    lastName: "Flyer",
    fullName: "Test Flyer",
  },
  seasonClubs: [],
  userId: null,
};

const mockHistory: PilotClubMembership[] = [
  {
    pilotId: "pilot-123",
    clubId: "club-1",
    clubName: "Alpha Soaring Club",
    joinedAt: "2010-01-01T00:00:00.000Z",
    leftAt: "2015-06-30T00:00:00.000Z",
    source: "legacy",
    legacyId: 1,
  },
];

const renderProfile = (pilotId = "pilot-123") =>
  render(
    <MemoryRouter initialEntries={[`/pilots/${pilotId}`]}>
      <Routes>
        <Route path="/pilots/:id" element={<PilotProfile />} />
      </Routes>
    </MemoryRouter>
  );

describe("PilotProfile club history", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("own profile renders Club History section with membership data", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "pilots/pilot-123") return mockPilot;
      if (path === "pilots/pilot-123/club-history") return mockHistory;
      throw new Error(`Unexpected path: ${path}`);
    });

    renderProfile();

    await waitFor(() => {
      expect(screen.getByText("Club History")).toBeInTheDocument();
    });

    expect(screen.getByText("Alpha Soaring Club")).toBeInTheDocument();
    expect(screen.getByText("legacy")).toBeInTheDocument();
  });

  it("missing history (404) surfaces empty state, not an error", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "pilots/pilot-123") return mockPilot;
      if (path === "pilots/pilot-123/club-history")
        throw new ApiError(404, "NOT_FOUND", "Not found");
      throw new Error(`Unexpected path: ${path}`);
    });

    renderProfile();

    await waitFor(() => {
      expect(screen.getByText("Club History")).toBeInTheDocument();
    });

    expect(screen.getByText("No club history recorded.")).toBeInTheDocument();
  });
});
