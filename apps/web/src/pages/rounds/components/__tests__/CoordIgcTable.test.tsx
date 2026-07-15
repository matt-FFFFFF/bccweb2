// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Flight, Round } from "@bccweb/types";
import { CoordIgcTable } from "../CoordIgcTable.js";
import { api, ApiError } from "../../../../lib/api.js";

vi.mock("../../../../lib/api.js", async () => {
  const actual = await vi.importActual("../../../../lib/api.js");
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  };
});

let mockIdentity: {
  userId: string;
  email: string;
  roles: string[];
  pilotId: string | null;
  clubId: string | null;
} | null = null;

vi.mock("../../../../hooks/useAuth.js", () => ({
  useAuth: () => ({ identity: mockIdentity, loading: false, logout: vi.fn() }),
}));

vi.mock("../../../../hooks/useBlob.js", () => ({
  useBlob: () => ({
    data: [
      { id: "p-up", name: "Uppy Loader" },
      { id: "p-man", name: "Manny Log" },
      { id: "p-none", name: "Nora Nothing" },
    ],
    loading: false,
    error: null,
    notFound: false,
  }),
}));

function flight(over: Partial<Flight>): Flight {
  return {
    id: "f",
    distance: 0,
    scoringType: "XC",
    score: 0,
    wingFactor: 1,
    isManualLog: false,
    ...over,
  };
}

function slot(placeInTeam: number, pilotId: string, f: Flight | null) {
  return {
    placeInTeam,
    isScoring: true,
    status: "Filled" as const,
    accountedFor: false,
    signToFly: false,
    noScore: false,
    pilotPoints: 0,
    pilotId,
    snapshot: null,
    flight: f,
  };
}

function makeRound(): Round {
  return {
    id: "r1",
    date: "2026-06-09",
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "s1", name: "Milk Hill" },
    organisingClub: { id: "cA", name: "Club A" },
    season: { year: 2026 },
    teams: [
      {
        id: "t1",
        teamName: "Alpha",
        club: { id: "cA", name: "Club A" },
        score: 0,
        pilots: [
          // Uploaded IGC (igcPath set, not manual) + a sanity flag + validation
          slot(
            1,
            "p-up",
            flight({
              id: "f-up",
              distance: 42.5,
              igcPath: "flight-igcs/r1/p-up.igc",
              isManualLog: false,
              sanityFlags: ["GPS_SPIKE"],
              validation: { signature: "unverified", date: "invalid" },
            }),
          ),
          // Manual log
          slot(2, "p-man", flight({ id: "f-man", distance: 30, isManualLog: true, validation: { signature: "invalid", date: "valid", overridden: true } })),
          // Empty — no flight / no IGC
          slot(3, "p-none", null),
        ],
      },
    ],
  };
}

const ADMIN = {
  userId: "u",
  email: "a@x",
  roles: ["Admin"],
  pilotId: null,
  clubId: null,
};

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mockIdentity = null;
  localStorage.clear();
});

describe("CoordIgcTable", () => {
  it("renders validation badges and actions correctly (Admin)", () => {
    mockIdentity = ADMIN;
    render(<CoordIgcTable round={makeRound()} onChanged={vi.fn()} />);

    // p-up: unverified signature, invalid date. Should have Resubmit, no Allow (since date is invalid but not overridden... wait, Allow shows when invalid AND not overridden. Let's check: date invalid => Allow should be there.)
    // Wait, the test config:
    // p-up: signature unverified, date invalid. Allow should show (due to date invalid). Resubmit should show (due to unverified).
    expect(screen.getByText("Sig: unverified")).toBeInTheDocument();
    expect(screen.getByText("Date: invalid")).toBeInTheDocument();

    // Check buttons
    expect(screen.getByTestId("revalidate-igc-btn")).toBeInTheDocument();
    expect(screen.getByTestId("allow-igc-btn")).toBeInTheDocument();

    // p-man: signature invalid, date valid, overridden.
    expect(screen.getByText("Sig: invalid")).toBeInTheDocument();
    expect(screen.getByText("Date: valid")).toBeInTheDocument();
    expect(screen.getByText("Overridden")).toBeInTheDocument();
    // Overridden => no Allow button for p-man. We can query all Allow buttons and there should be 1.
    expect(screen.getAllByTestId("allow-igc-btn")).toHaveLength(1);
  });

  it("posts to revalidate endpoint when Resubmit is clicked", async () => {
    mockIdentity = ADMIN;
    const onChanged = vi.fn();
    vi.mocked(api.post).mockResolvedValue(undefined);

    render(<CoordIgcTable round={makeRound()} onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId("revalidate-igc-btn"));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("rounds/r1/teams/t1/pilots/1/igc/revalidate", {});
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("surfaces ApiError detail string when Resubmit fails", async () => {
    mockIdentity = ADMIN;
    const errorWithDetail = new ApiError(409, "CONFLICT", "Conflict", "req-1", "IGC signature validation is disabled.");
    vi.mocked(api.post).mockRejectedValueOnce(errorWithDetail);

    render(<CoordIgcTable round={makeRound()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId("revalidate-igc-btn"));

    await waitFor(() => {
      expect(screen.getByText("IGC signature validation is disabled.")).toBeInTheDocument();
    });
  });

  it("posts to allow endpoint when Allow is clicked", async () => {
    mockIdentity = ADMIN;
    const onChanged = vi.fn();
    vi.mocked(api.post).mockResolvedValue(undefined);

    render(<CoordIgcTable round={makeRound()} onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId("allow-igc-btn"));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("rounds/r1/teams/t1/pilots/1/igc/allow", {});
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("surfaces ApiError detail string when Allow fails", async () => {
    mockIdentity = ADMIN;
    const errorWithDetail = new ApiError(409, "CONFLICT", "Conflict", "req-1", "Allow logic blocked.");
    vi.mocked(api.post).mockRejectedValueOnce(errorWithDetail);

    render(<CoordIgcTable round={makeRound()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId("allow-igc-btn"));

    await waitFor(() => {
      expect(screen.getByText("Allow logic blocked.")).toBeInTheDocument();
    });
  });

  it("shows Resubmit to scoped coord but hides Allow", () => {
    mockIdentity = {
      userId: "u",
      email: "c@x",
      roles: ["RoundsCoord"],
      pilotId: null,
      clubId: "cA",
    };
    render(<CoordIgcTable round={makeRound()} onChanged={vi.fn()} />);

    expect(screen.getByTestId("revalidate-igc-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("allow-igc-btn")).toBeNull();
  });

  it("renders NO Resubmit and NO Allow buttons for a manual flight with stale validation", () => {
    const round = makeRound();
    round.teams[0].pilots = [
      slot(1, "p-man", flight({ id: "f-man", distance: 30, isManualLog: true, validation: { signature: "unverified", date: "invalid" } }))
    ];

    mockIdentity = ADMIN;
    render(<CoordIgcTable round={round} onChanged={vi.fn()} />);
    expect(screen.getByText("Sig: unverified")).toBeInTheDocument();
    expect(screen.queryByTestId("revalidate-igc-btn")).toBeNull();
    expect(screen.queryByTestId("allow-igc-btn")).toBeNull();
    cleanup();

    mockIdentity = {
      userId: "u",
      email: "c@x",
      roles: ["RoundsCoord"],
      pilotId: null,
      clubId: "cA",
    };
    render(<CoordIgcTable round={round} onChanged={vi.fn()} />);
    expect(screen.queryByTestId("revalidate-igc-btn")).toBeNull();
    expect(screen.queryByTestId("allow-igc-btn")).toBeNull();
  });

  it("renders one row per slot with the correct IGC status string (Admin)", () => {
    mockIdentity = ADMIN;
    render(<CoordIgcTable round={makeRound()} onChanged={vi.fn()} />);

    expect(screen.getByTestId("coord-igc-table")).toBeInTheDocument();
    const statuses = screen.getAllByTestId("igc-status").map((el) => el.textContent);
    expect(statuses).toEqual(["Uploaded", "Manual", "No IGC"]);

    // Sanity flag pill for the uploaded row
    expect(screen.getByText("GPS_SPIKE")).toBeInTheDocument();
    // Raw distance shown (not the multiplied score column)
    expect(screen.getByText("42.5")).toBeInTheDocument();
  });

  it("Delete IGC calls api.delete with the slot IGC URL and fires onChanged", async () => {
    mockIdentity = ADMIN;
    const onChanged = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.delete).mockResolvedValue(undefined);

    render(<CoordIgcTable round={makeRound()} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete IGC" }));

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith("rounds/r1/teams/t1/pilots/1/igc");
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("Delete flight calls api.delete with the legacy flights URL using the flight id", async () => {
    mockIdentity = ADMIN;
    const onChanged = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.delete).mockResolvedValue(undefined);

    render(<CoordIgcTable round={makeRound()} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete flight" }));

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith("rounds/r1/flights/f-man");
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("Download IGC issues an authenticated fetch with the Bearer token", async () => {
    mockIdentity = ADMIN;
    localStorage.setItem("bcc_access_token", "tok");
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, blob: async () => new Blob(["igc"]) });
    URL.createObjectURL = vi.fn(() => "blob:mock") as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<CoordIgcTable round={makeRound()} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByTestId("download-igc-btn"));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/rounds/r1/teams/t1/pilots/1/igc",
        expect.objectContaining({ headers: { Authorization: "Bearer tok" } }),
      );
    });
  });

  it("is hidden for a plain Pilot identity", () => {
    mockIdentity = {
      userId: "u",
      email: "p@x",
      roles: ["Pilot"],
      pilotId: "p-up",
      clubId: "cA",
    };
    render(<CoordIgcTable round={makeRound()} onChanged={vi.fn()} />);

    expect(screen.queryByTestId("coord-igc-table")).toBeNull();
  });
});
