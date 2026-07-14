// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AdminConfig from "../Config.js";
import { api } from "../../../lib/api.js";
import type { Config } from "@bccweb/types";

vi.mock("../../../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/api.js")>("../../../lib/api.js");
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
      userId: "admin-user",
      email: "admin@example.test",
      roles: ["Admin"],
      pilotId: null,
      clubId: null,
    },
    loading: false,
    isRefreshing: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshIdentity: vi.fn(),
  }),
}));

describe("AdminConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const mockConfig: Config = {
    maxTeamsInClub: 3,
    maxPilotsInTeam: 10,
    maxScoringPilotsInTeam: 7,
    maxPilotScoresCountedPerTeam: 5,
    leagueRoundScoresCounted: 4,
    taskMaxPoints: 900,
    flightDateValidationEnabled: false,
    roundBriefRecipients: [],
    wingFactors: {
      "EN A": 1.1,
      "EN B": 0.95,
      "EN C": 0.85,
      "EN C 2-liner": 0.75,
      "EN D": 0.65,
      "EN D 2-liner": 0.55,
    },
    pilotFactors: {
      "Club Pilot": 1.2,
      "Pilot": 1.1,
      "Advanced Pilot": 0.95,
    },
    clubsAttendingFactors: {
      fewerThanThreeClubs: 0.6,
      exactlyThreeClubs: 0.8,
      moreThanThreeClubs: 1.1,
    },
    minDistanceFactors: {
      oneFlight: 0.3,
      twoFlights: 0.5,
      threeFlights: 0.7,
      fourFlights: 0.9,
      fiveOrMoreFlights: 1.2,
    },
  };

  it("renders the new fields from the loaded config and submits the fully modified payload", async () => {
    vi.mocked(api.get).mockResolvedValue(mockConfig);
    vi.mocked(api.put).mockResolvedValue({});

    render(<AdminConfig />);

    // Wait for the form to render
    await screen.findByRole("heading", { name: "League Config" });

    // Helper to get input by label text when they are just sibling nodes
    function getInputByLabel(text: string) {
      return screen.getByText(text).parentElement?.querySelector("input") as HTMLInputElement;
    }

    // Assert existing fields
    expect(getInputByLabel("Max teams per club")).toHaveValue(3);
    
    // Assert new counts
    expect(getInputByLabel("Pilot scores counted per team")).toHaveValue(5);
    expect(getInputByLabel("League rounds counted")).toHaveValue(4);
    expect(getInputByLabel("Task max points")).toHaveValue(900);

    // Assert factor fields
    expect(getInputByLabel("Advanced Pilot")).toHaveValue(0.95);
    expect(getInputByLabel("Exactly 3 clubs")).toHaveValue(0.8);
    expect(getInputByLabel("3 flights")).toHaveValue(0.7);

    // Edit a few fields
    fireEvent.change(getInputByLabel("Advanced Pilot"), { target: { value: "0.98" } });
    fireEvent.change(getInputByLabel("3 flights"), { target: { value: "0.75" } });
    fireEvent.change(getInputByLabel("Pilot scores counted per team"), { target: { value: "6" } });

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /Save config/ }));

    // Verify PUT request
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("manage/config", {
        maxTeamsInClub: 3,
        maxPilotsInTeam: 10,
        maxScoringPilotsInTeam: 7,
        maxPilotScoresCountedPerTeam: 6, // edited
        leagueRoundScoresCounted: 4,
        taskMaxPoints: 900,
        flightDateValidationEnabled: false,
        roundBriefRecipients: [],
        wingFactors: {
          "EN A": 1.1,
          "EN B": 0.95,
          "EN C": 0.85,
          "EN C 2-liner": 0.75,
          "EN D": 0.65,
          "EN D 2-liner": 0.55,
        },
        pilotFactors: {
          "Club Pilot": 1.2,
          "Pilot": 1.1,
          "Advanced Pilot": 0.98, // edited
        },
        clubsAttendingFactors: {
          fewerThanThreeClubs: 0.6,
          exactlyThreeClubs: 0.8,
          moreThanThreeClubs: 1.1,
        },
        minDistanceFactors: {
          oneFlight: 0.3,
          twoFlights: 0.5,
          threeFlights: 0.75, // edited
          fourFlights: 0.9,
          fiveOrMoreFlights: 1.2,
        },
      });
    });
  });
});
