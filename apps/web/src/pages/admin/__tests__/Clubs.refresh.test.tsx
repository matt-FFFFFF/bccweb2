import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import AdminClubs from "../Clubs.js";

// Mock hooks
vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: () => ({
    identity: { roles: ["Admin"], userId: "u1", email: "a@b.c", pilotId: null, clubId: null },
    loading: false,
    isRefreshing: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshIdentity: vi.fn(),
  }),
}));

vi.mock("../../../lib/api.js", () => ({
  api: {
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn(),
    delete: vi.fn(),
    deleteJson: vi.fn(),
  },
}));

vi.mock("../../../lib/blobClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/blobClient.js")>();
  
  let teamCallCount = 0;
  
  return {
    ...actual,
    readPublicBlob: vi.fn(async (path: string) => {
      const base = path.split("?")[0];
      
      if (base === "clubs.json") {
        return [{ id: "club-1", name: "Alpha" }];
      }
      
      if (base === "seasons.json") {
        return [{ year: 2026, active: true }];
      }
      
      if (base === "club-teams.json") {
        teamCallCount++;
        if (teamCallCount === 1) {
          return [];
        } else {
          return [{ id: "t1", clubId: "club-1", clubName: "Alpha", seasonYear: 2026, teamName: "Alpha A" }];
        }
      }
      
      throw new actual.BlobNotFoundError("Not found");
    }),
  };
});

import { readPublicBlob } from "../../../lib/blobClient.js";

describe("AdminClubs refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-refreshes data and keeps teams panel expanded", async () => {
    render(
      <MemoryRouter>
        <AdminClubs />
      </MemoryRouter>
    );

    // Initial mount calls
    await waitFor(() => {
      expect(readPublicBlob).toHaveBeenCalledWith("clubs.json?v=0", undefined);
      expect(readPublicBlob).toHaveBeenCalledWith("club-teams.json?v=0", undefined);
    });

    // 1. CLUBS PATH: create a club
    const clubNameInput = screen.getByPlaceholderText("Club name");
    fireEvent.change(clubNameInput, { target: { value: "Beta" } });
    
    const createClubBtn = screen.getByRole("button", { name: "Create" });
    fireEvent.click(createClubBtn);
    
    // Ensure it refetched clubs.json
    await waitFor(() => {
      expect(readPublicBlob).toHaveBeenCalledWith("clubs.json?v=1", undefined);
    });

    // 2. TEAMS PATH: expand the Teams panel
    const expandTeamsBtn = screen.getByRole("button", { name: "Teams (0)" });
    fireEvent.click(expandTeamsBtn);
    
    // Add team
    const newTeamInput = screen.getByPlaceholderText("New team name");
    fireEvent.change(newTeamInput, { target: { value: "Alpha A" } });
    
    const addTeamBtn = screen.getByRole("button", { name: "Add Team" });
    fireEvent.click(addTeamBtn);
    
    // Ensure it refetched club-teams.json
    await waitFor(() => {
      expect(readPublicBlob).toHaveBeenCalledWith("club-teams.json?v=1", undefined);
    });
    
    // KEEP-EXPANDED (Bug 1b):
    // The panel should still be open
    expect(screen.getByRole("button", { name: "Hide Teams" })).toBeInTheDocument();
    
    // And the new team should be visible
    expect(screen.getByText("Alpha A")).toBeInTheDocument();
  });
});
