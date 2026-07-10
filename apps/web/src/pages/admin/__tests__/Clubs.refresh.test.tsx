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
  return {
    ...actual,
    readPublicBlob: vi.fn(),
  };
});

import { readPublicBlob, BlobNotFoundError } from "../../../lib/blobClient.js";
import { api, ApiError } from "../../../lib/api.js";

const TEAM = { id: "t1", clubId: "club-1", clubName: "Alpha", seasonYear: 2026, teamName: "Alpha A" };

function defaultBlobImpl() {
  vi.mocked(readPublicBlob).mockImplementation(async (path: string) => {
    const base = path.split("?")[0];
    if (base === "clubs.json") return [{ id: "club-1", name: "Alpha" }] as never;
    if (base === "seasons.json") return [{ year: 2026, active: true }] as never;
    if (base === "club-teams.json") return [TEAM] as never;
    throw new BlobNotFoundError("Not found");
  });
}

describe("AdminClubs refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultBlobImpl();
  });

  it("keeps the club edit panel expanded when adding the first-ever team", async () => {
    // First-ever visit: club-teams.json does not exist yet (BlobNotFoundError),
    // and the post-add refetch is held pending so the in-flight UI can be
    // inspected — that pending window is exactly when the buggy full-page
    // spinner would unmount the list and collapse the open panel.
    let resolveTeamsRefetch!: () => void;
    const teamsRefetch = new Promise<void>((r) => { resolveTeamsRefetch = r; });
    let teamsCall = 0;

    vi.mocked(readPublicBlob).mockImplementation(async (path: string) => {
      const base = path.split("?")[0];
      if (base === "clubs.json") return [{ id: "club-1", name: "Alpha" }] as never;
      if (base === "seasons.json") return [{ year: 2026, active: true }] as never;
      if (base === "club-teams.json") {
        teamsCall++;
        if (teamsCall === 1) throw new BlobNotFoundError("Not found");
        await teamsRefetch;
        return [TEAM] as never;
      }
      throw new BlobNotFoundError("Not found");
    });

    render(
      <MemoryRouter>
        <AdminClubs />
      </MemoryRouter>
    );

    // Open the club's Edit panel (Teams management lives inside it).
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    // Add the first team; its index refetch stays pending (teamsRefetch).
    fireEvent.change(screen.getByPlaceholderText("New team name"), { target: { value: "Alpha A" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Team" }));

    await waitFor(() => {
      expect(readPublicBlob).toHaveBeenCalledWith("club-teams.json?v=1", undefined);
    });

    // Regression guard: while the refetch is in flight the panel must stay open
    // and the full-page loading spinner must NOT replace the club list.
    expect(screen.queryByText("Loading clubs…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    // Complete the refetch: the new team appears and the panel is still open.
    resolveTeamsRefetch();
    expect(await screen.findByText("Alpha A")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("refetches clubs.json after creating a club", async () => {
    render(
      <MemoryRouter>
        <AdminClubs />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(readPublicBlob).toHaveBeenCalledWith("clubs.json?v=0", undefined);
    });

    fireEvent.change(screen.getByPlaceholderText("Club name"), { target: { value: "Beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(readPublicBlob).toHaveBeenCalledWith("clubs.json?v=1", undefined);
    });
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
