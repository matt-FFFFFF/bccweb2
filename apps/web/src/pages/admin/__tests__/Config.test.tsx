// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/// <reference types="@testing-library/jest-dom" />
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

  describe("Round brief recipients", () => {
    it("case 1: load config -> both render", async () => {
      vi.mocked(api.get).mockResolvedValue({ ...mockConfig, roundBriefRecipients: ["a@x.com", "b@y.com"] });
      render(<AdminConfig />);
      await screen.findByRole("heading", { name: "League Config" });
      expect(screen.getByDisplayValue("a@x.com")).toBeInTheDocument();
      expect(screen.getByDisplayValue("b@y.com")).toBeInTheDocument();
    });

    it("case 2: type invalid email + Add -> NOT added, error shown", async () => {
      vi.mocked(api.get).mockResolvedValue(mockConfig);
      render(<AdminConfig />);
      await screen.findByRole("heading", { name: "League Config" });
      fireEvent.change(screen.getByLabelText("New recipient email"), { target: { value: "invalid" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(screen.queryByDisplayValue("invalid")).not.toHaveAttribute("aria-label", expect.stringContaining("Recipient"));
      expect(screen.getByText("Invalid email.")).toBeInTheDocument();
    });

    it("rejects consecutive dots in the email domain before adding a recipient", async () => {
      vi.mocked(api.get).mockResolvedValue(mockConfig);
      render(<AdminConfig />);
      await screen.findByRole("heading", { name: "League Config" });

      fireEvent.change(screen.getByLabelText("New recipient email"), {
        target: { value: "a@b..com" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(screen.queryByLabelText("Recipient 1")).not.toBeInTheDocument();
      expect(screen.getByText("Invalid email.")).toBeInTheDocument();
    });

    it("case 3: add c@z.com -> appears", async () => {
      vi.mocked(api.get).mockResolvedValue(mockConfig);
      render(<AdminConfig />);
      await screen.findByRole("heading", { name: "League Config" });
      fireEvent.change(screen.getByLabelText("New recipient email"), { target: { value: "c@z.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(screen.getByDisplayValue("c@z.com")).toBeInTheDocument();
      expect(screen.getByLabelText("Recipient 1")).toHaveValue("c@z.com");
    });

    it("case 4: remove a@x.com -> gone", async () => {
      vi.mocked(api.get).mockResolvedValue({ ...mockConfig, roundBriefRecipients: ["a@x.com", "b@y.com"] });
      render(<AdminConfig />);
      await screen.findByRole("heading", { name: "League Config" });
      const removeBtns = screen.getAllByRole("button", { name: "Remove" });
      fireEvent.click(removeBtns[0]);
      expect(screen.queryByDisplayValue("a@x.com")).not.toBeInTheDocument();
      expect(screen.getByDisplayValue("b@y.com")).toBeInTheDocument();
    });

    it("case 5: edit a row to a valid new address + Save -> api.put called with edited list", async () => {
      vi.mocked(api.get).mockResolvedValue({ ...mockConfig, roundBriefRecipients: ["a@x.com"] });
      vi.mocked(api.put).mockResolvedValue({});
      render(<AdminConfig />);
      await screen.findByRole("heading", { name: "League Config" });
      fireEvent.change(screen.getByLabelText("Recipient 1"), { target: { value: "new@x.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Save config" }));
      await waitFor(() => {
        expect(api.put).toHaveBeenCalledWith("manage/config", expect.objectContaining({
          roundBriefRecipients: ["new@x.com"],
        }));
      });
    });

    it("case 6: edit a row to an invalid address -> Save BLOCKED with inline error, api.put NOT called", async () => {
      vi.mocked(api.get).mockResolvedValue({ ...mockConfig, roundBriefRecipients: ["a@x.com"] });
      vi.mocked(api.put).mockResolvedValue({});
      render(<AdminConfig />);
      await screen.findByRole("heading", { name: "League Config" });
      fireEvent.change(screen.getByLabelText("Recipient 1"), { target: { value: "invalid" } });
      expect(screen.getByText("Invalid email.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Save config" }));
      expect(screen.getByText("Please fix invalid or duplicate email recipients before saving.")).toBeInTheDocument();
      expect(api.put).not.toHaveBeenCalled();
    });

    it("case 7: load 2 recipients, Save with NO changes -> api.put body.roundBriefRecipients deep-equals the original 2", async () => {
      vi.mocked(api.get).mockResolvedValue({ ...mockConfig, roundBriefRecipients: ["a@x.com", "b@y.com"] });
      vi.mocked(api.put).mockResolvedValue({});
      render(<AdminConfig />);
      await screen.findByRole("heading", { name: "League Config" });
      fireEvent.click(screen.getByRole("button", { name: "Save config" }));
      await waitFor(() => {
        expect(api.put).toHaveBeenCalledWith("manage/config", expect.objectContaining({
          roundBriefRecipients: ["a@x.com", "b@y.com"],
        }));
      });
    });

    it("case 8: add with surrounding whitespace -> persisted api.put body value is trimmed", async () => {
      vi.mocked(api.get).mockResolvedValue(mockConfig);
      vi.mocked(api.put).mockResolvedValue({});
      render(<AdminConfig />);
      await screen.findByRole("heading", { name: "League Config" });
      fireEvent.change(screen.getByLabelText("New recipient email"), { target: { value: "  d@z.com  " } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      fireEvent.click(screen.getByRole("button", { name: "Save config" }));
      await waitFor(() => {
        expect(api.put).toHaveBeenCalledWith("manage/config", expect.objectContaining({
          roundBriefRecipients: ["d@z.com"],
        }));
      });
    });

    it("case 9a: Add a case-only duplicate -> NOT added / Save BLOCKED with inline error", async () => {
      vi.mocked(api.get).mockResolvedValue({ ...mockConfig, roundBriefRecipients: ["a@x.com"] });
      render(<AdminConfig />);
      await screen.findByRole("heading", { name: "League Config" });
      fireEvent.change(screen.getByLabelText("New recipient email"), { target: { value: "A@X.COM" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(screen.getByText("Duplicate email.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Recipient 2")).not.toBeInTheDocument();
    });

    it("case 9b: inline-edit an existing row to a case-only duplicate -> Save BLOCKED with inline error", async () => {
      vi.mocked(api.get).mockResolvedValue({ ...mockConfig, roundBriefRecipients: ["a@x.com", "b@y.com"] });
      vi.mocked(api.put).mockResolvedValue({});
      render(<AdminConfig />);
      await screen.findByRole("heading", { name: "League Config" });
      fireEvent.change(screen.getByLabelText("Recipient 2"), { target: { value: "A@X.COM" } });
      expect(screen.getByText("Duplicate email.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Save config" }));
      expect(screen.getByText("Please fix invalid or duplicate email recipients before saving.")).toBeInTheDocument();
      expect(api.put).not.toHaveBeenCalled();
    });
  });
});
