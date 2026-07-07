import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  Flight,
  RescoreJob,
  RescoreJobCounts,
  RescoreJobStatus,
  Round,
} from "@bccweb/types";
import { RescoreRoundButton } from "../RescoreRoundButton.js";
import { api } from "../../../../lib/api.js";

// api.js is 4 levels up from components/__tests__/. Keep `...actual` so the real
// `ApiError` export (imported by the component) survives the mock.
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

const ADMIN = {
  userId: "u",
  email: "a@x",
  roles: ["Admin"],
  pilotId: null,
  clubId: null,
};

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

function makeRound(status: Round["status"] = "Locked"): Round {
  return {
    id: "r1",
    date: "2026-06-09",
    status,
    isLocked: status === "Locked",
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
          slot(1, "p1", flight({ id: "f1", distance: 40, igcPath: "flight-igcs/r1/p1.igc" })),
          slot(2, "p2", flight({ id: "f2", distance: 35, igcPath: "flight-igcs/r1/p2.igc" })),
        ],
      },
    ],
  };
}

const COUNTS: RescoreJobCounts = {
  rescoredCount: 3,
  skippedManualCount: 1,
  skippedNoIgcCount: 2,
  skippedBudgetCount: 0,
  errorCount: 0,
};

function job(
  status: RescoreJobStatus,
  counts?: RescoreJobCounts,
  errors?: RescoreJob["errors"],
): RescoreJob {
  return {
    jobId: "job-1",
    roundId: "r1",
    status,
    requestedByEmail: "a@x",
    requestedAt: "2026-06-09T10:00:00Z",
    ...(counts ? { counts } : {}),
    ...(errors ? { errors } : {}),
  };
}

/** Advance fake timers + flush the microtasks the async callbacks queue. */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  mockIdentity = null;
  localStorage.clear();
});

describe("RescoreRoundButton", () => {
  it("enqueues (202 + jobId), polls running×2 then completed, and renders the counts", async () => {
    vi.useFakeTimers();
    mockIdentity = ADMIN;
    const onChanged = vi.fn();
    vi.mocked(api.post).mockResolvedValue({ jobId: "job-1", status: "queued" });
    vi.mocked(api.get)
      .mockResolvedValueOnce(job("running"))
      .mockResolvedValueOnce(job("running"))
      .mockResolvedValueOnce(job("completed", COUNTS));

    render(<RescoreRoundButton round={makeRound()} onChanged={onChanged} />);

    // Confirmation is required — POST must not fire until the user confirms.
    fireEvent.click(screen.getByTestId("rescore-round-btn"));
    expect(screen.getByTestId("rescore-confirm-dialog")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("rescore-confirm-yes"));
    // Flush the enqueue POST microtask so the poll interval is scheduled.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.post).toHaveBeenCalledWith("rounds/r1/rescore");
    expect(screen.getByTestId("rescore-loading-overlay")).toHaveTextContent(
      "Re-scoring 2 pilots",
    );

    // Two "running" polls — overlay persists, no success modal yet.
    await tick(3000);
    await tick(3000);
    expect(screen.getByTestId("rescore-loading-overlay")).toBeInTheDocument();
    expect(screen.queryByTestId("rescore-success-modal")).toBeNull();

    // Third poll returns "completed" → success modal with the counters.
    await tick(3000);

    expect(screen.getByTestId("rescore-success-modal")).toBeInTheDocument();
    expect(screen.getByTestId("rescore-count-rescored")).toHaveTextContent("3");
    expect(screen.getByTestId("rescore-count-manual")).toHaveTextContent("1");
    expect(screen.getByTestId("rescore-count-no-igc")).toHaveTextContent("2");
    expect(screen.getByTestId("rescore-count-budget")).toHaveTextContent("0");
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(api.get).toHaveBeenCalledWith("rounds/r1/rescore/job-1");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows a partial warning banner and still lists counts on a partial result", async () => {
    vi.useFakeTimers();
    mockIdentity = ADMIN;
    const onChanged = vi.fn();
    vi.mocked(api.post).mockResolvedValue({ jobId: "job-1", status: "queued" });
    vi.mocked(api.get).mockResolvedValueOnce(
      job("partial", { ...COUNTS, skippedBudgetCount: 4 }),
    );

    render(<RescoreRoundButton round={makeRound("Complete")} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("rescore-round-btn"));
    fireEvent.click(screen.getByTestId("rescore-confirm-yes"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await tick(3000);

    expect(screen.getByTestId("rescore-success-modal")).toBeInTheDocument();
    expect(screen.getByTestId("rescore-partial-warning")).toHaveTextContent(
      "Budget reached",
    );
    expect(screen.getByTestId("rescore-count-budget")).toHaveTextContent("4");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows the error modal when the job fails and does not call onChanged", async () => {
    vi.useFakeTimers();
    mockIdentity = ADMIN;
    const onChanged = vi.fn();
    vi.mocked(api.post).mockResolvedValue({ jobId: "job-1", status: "queued" });
    vi.mocked(api.get).mockResolvedValueOnce(
      job("failed", undefined, [{ teamId: "t1", place: 1, error: "solver exploded" }]),
    );

    render(<RescoreRoundButton round={makeRound()} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("rescore-round-btn"));
    fireEvent.click(screen.getByTestId("rescore-confirm-yes"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await tick(3000);

    expect(screen.getByTestId("rescore-error-modal")).toHaveTextContent("solver exploded");
    expect(screen.queryByTestId("rescore-success-modal")).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("is hidden for a non-Admin (RoundsCoord) identity", () => {
    mockIdentity = {
      userId: "u",
      email: "c@x",
      roles: ["RoundsCoord"],
      pilotId: null,
      clubId: "cA",
    };
    render(<RescoreRoundButton round={makeRound()} onChanged={vi.fn()} />);
    expect(screen.queryByTestId("rescore-round-btn")).toBeNull();
  });

  it("is hidden for an Admin when the round is neither Locked nor Complete", () => {
    mockIdentity = ADMIN;
    render(<RescoreRoundButton round={makeRound("Confirmed")} onChanged={vi.fn()} />);
    expect(screen.queryByTestId("rescore-round-btn")).toBeNull();
  });

  it("is visible for an Admin on a Complete round", () => {
    mockIdentity = ADMIN;
    render(<RescoreRoundButton round={makeRound("Complete")} onChanged={vi.fn()} />);
    expect(screen.getByTestId("rescore-round-btn")).toBeInTheDocument();
  });
});
