import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import RegisterForRound from "../RegisterForRound.js";
import { api, ApiError } from "../../../lib/api.js";

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
      email: "pilot@example.com",
      roles: ["Pilot"],
      pilotId: "p1",
      clubId: "c1",
    },
    loading: false,
    logout: vi.fn(),
  }),
}));

describe("RegisterForRound", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("happy path renders form + submits", async () => {
    mockRoundAndPilot();
    vi.mocked(api.post).mockResolvedValueOnce({ roundId: "r1", teamId: "t1", place: 2 });

    renderComponent();

    expect(await screen.findByRole("heading", { name: /Register for Milk Hill/ })).toBeInTheDocument();
    expect(await screen.findByDisplayValue(/First available slot/)).toBeInTheDocument();
    const registerButton = await screen.findByRole("button", { name: "Register for this round" });
    await waitFor(() => expect(registerButton).toBeEnabled());
    fireEvent.click(registerButton);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("rounds/r1/register-self", { teamId: "t1" });
      expect(screen.getByTestId("location")).toHaveTextContent("/rounds/r1");
    });
  });

  it("DOUBLE_BOOKING error shows conflict round info", async () => {
    mockRoundAndPilot();
    vi.mocked(api.post).mockRejectedValueOnce(
      new ApiError(409, "DOUBLE_BOOKING", "Conflict", "req-1", "Conflicting round r2 on 2026-06-09"),
    );

    renderComponent();

    const registerButton = await screen.findByRole("button", { name: "Register for this round" });
    await waitFor(() => expect(registerButton).toBeEnabled());
    fireEvent.click(registerButton);

    expect(await screen.findByText("You are already booked into another round.")).toBeInTheDocument();
    expect(screen.getByText("Conflicting round r2 on 2026-06-09")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cancel my booking on 2026-06-09 first" })).toHaveAttribute("href", "/rounds/r2");
  });
});

function renderComponent() {
  return render(
    <MemoryRouter initialEntries={["/rounds/r1/register"]}>
      <Routes>
        <Route path="/rounds/:id/register" element={<RegisterForRound />} />
        <Route path="/rounds/:id" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function mockRoundAndPilot() {
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path === "rounds/r1") {
      return {
        id: "r1",
        date: "2026-06-09",
        status: "Confirmed",
        isLocked: false,
        maxTeams: 8,
        minimumScore: 0,
        site: { id: "s1", name: "Milk Hill" },
        organisingClub: { id: "c1", name: "Test Club" },
        season: { year: 2026 },
        teams: [{
          id: "t1",
          teamName: "A Team",
          club: { id: "c1", name: "Test Club" },
          score: 0,
          pilots: [{
            placeInTeam: 1,
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            pilotId: "other",
            snapshot: null,
            flight: null,
          }],
        }],
      };
    }
    if (path === "pilots/p1") {
      return {
        id: "p1",
        coachType: "None",
        pilotRating: "Pilot",
        wingClass: "EN B",
        person: { id: "person1", firstName: "Pat", lastName: "Pilot", fullName: "Pat Pilot" },
        currentClub: { id: "c1", name: "Test Club" },
        seasonClubs: [{ seasonYear: 2026, clubId: "c1", clubName: "Test Club" }],
        userId: "u1",
      };
    }
    throw new Error(`unexpected api.get ${path}`);
  });
}
