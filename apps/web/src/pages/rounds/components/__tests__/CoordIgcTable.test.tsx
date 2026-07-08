// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Flight, Round } from "@bccweb/types";
import { CoordIgcTable } from "../CoordIgcTable.js";
import { api } from "../../../../lib/api.js";

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
          // Uploaded IGC (igcPath set, not manual) + a sanity flag
          slot(
            1,
            "p-up",
            flight({
              id: "f-up",
              distance: 42.5,
              igcPath: "flight-igcs/r1/p-up.igc",
              isManualLog: false,
              sanityFlags: ["GPS_SPIKE"],
            }),
          ),
          // Manual log
          slot(2, "p-man", flight({ id: "f-man", distance: 30, isManualLog: true })),
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
