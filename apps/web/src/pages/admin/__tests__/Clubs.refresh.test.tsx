// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
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

vi.mock("../../../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api.js")>();
  return {
    ApiError: actual.ApiError,
    api: {
      post: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
      deleteJson: vi.fn(),
    },
  };
});

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
import { api, ApiError } from "../../../lib/api.js";

describe("AdminClubs refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-refreshes data and keeps the club edit panel expanded", async () => {
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

    // 2. TEAMS PATH: open the club's Edit panel (Teams management lives inside it)
    const editBtn = screen.getByRole("button", { name: "Edit" });
    fireEvent.click(editBtn);

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
    // The edit panel should still be open (toggle now reads "Close")
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    // And the new team should be visible
    expect(screen.getByText("Alpha A")).toBeInTheDocument();
  });

  it("deletes an unreferenced club via api.delete (204)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <MemoryRouter>
        <AdminClubs />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(readPublicBlob).toHaveBeenCalledWith("clubs.json?v=0", undefined);
    });

    // Open the club's Edit panel and delete it
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Club" }));

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith("clubs/club-1");
    });
  });

  it("keeps the club listed and surfaces CLUB_IN_USE when delete returns 409", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const inUseMessage = "Club still has teams, sites, or season registrations.";
    vi.mocked(api.delete).mockRejectedValueOnce(new ApiError(409, "CLUB_IN_USE", "Conflict", undefined, inUseMessage));

    render(
      <MemoryRouter>
        <AdminClubs />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(readPublicBlob).toHaveBeenCalledWith("clubs.json?v=0", undefined);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Club" }));

    // Server message surfaces
    await waitFor(() => {
      expect(screen.getByText(inUseMessage)).toBeInTheDocument();
    });

    // The delete was attempted, but the club stays listed
    expect(api.delete).toHaveBeenCalledWith("clubs/club-1");
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });
});
