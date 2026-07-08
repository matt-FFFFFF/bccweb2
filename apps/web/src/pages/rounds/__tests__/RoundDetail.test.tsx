import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { Round, RescoreJob, RescoreJobCounts, RescoreJobStatus } from "@bccweb/types";
import RoundDetail from "../RoundDetail.js";
import { api, ApiError } from "../../../lib/api.js";

vi.mock("../../../lib/api.js", async () => {
  const actual = await vi.importActual("../../../lib/api.js");
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  };
});

let mockIdentity: {
  userId: string;
  email: string;
  roles: string[];
  pilotId: string | null;
  clubId: string | null;
} | null = null;

vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: () => ({ identity: mockIdentity, loading: false, logout: vi.fn() }),
}));

vi.mock("../../../hooks/useBlob.js", () => ({
  useBlob: () => ({
    data: [
      { id: "cap", name: "Cap Tain" },
      { id: "mem", name: "Mem Ber" },
      { id: "oth", name: "Oth Er" },
    ],
    loading: false,
    error: null,
    notFound: false,
  }),
}));

function slot(placeInTeam: number, pilotId: string, accountedFor = false) {
  return {
    placeInTeam,
    isScoring: true,
    status: "Filled" as const,
    accountedFor,
    signToFly: false,
    noScore: false,
    pilotPoints: 0,
    pilotId,
    snapshot: null,
    flight: null,
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
        captainPilotId: "cap",
        pilots: [slot(1, "cap", true), slot(2, "mem", false)],
      },
      {
        id: "t2",
        teamName: "Bravo",
        club: { id: "cB", name: "Club B" },
        score: 0,
        captainPilotId: "oth",
        pilots: [slot(1, "oth", false)],
      },
    ],
  };
}

function mockLoad(round: Round) {
  vi.mocked(api.get).mockImplementation((path: string) => {
    if (path === "rounds/r1") return Promise.resolve(round) as Promise<unknown>;
    if (path === "rounds/r1/brief") {
      return Promise.reject(new ApiError(404, "NOT_FOUND", "no brief"));
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/rounds/r1"]}>
      <Routes>
        <Route path="/rounds/:id" element={<RoundDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RoundDetail — accounted-for management outside the manage page", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    cleanup();
    mockIdentity = null;
  });

  it("team captain sees a toggle for every member of THEIR team, none for other teams", async () => {
    mockIdentity = { userId: "u", email: "c@x", roles: ["Pilot"], pilotId: "cap", clubId: "cA" };
    mockLoad(makeRound("Locked"));

    renderPage();

    await screen.findByRole("heading", { name: "Milk Hill" });
    const buttons = await screen.findAllByRole("button", { name: /accounted for/i });
    // team1 place1 (already accounted) + team1 place2 (not yet) = 2; team2 excluded
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole("button", { name: "✓ Accounted for" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark accounted for" })).toBeInTheDocument();
  });

  it("captain clicking a member's toggle PUTs { accountedFor } to the right slot", async () => {
    mockIdentity = { userId: "u", email: "c@x", roles: ["Pilot"], pilotId: "cap", clubId: "cA" };
    mockLoad(makeRound("Locked"));
    vi.mocked(api.put).mockResolvedValue({});

    renderPage();

    const markBtn = await screen.findByRole("button", { name: "Mark accounted for" });
    fireEvent.click(markBtn);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("rounds/r1/teams/t1/pilots/2/accounted", {
        accountedFor: true,
      });
    });
  });

  it("non-captain pilot sees a toggle ONLY for their own slot", async () => {
    mockIdentity = { userId: "u", email: "m@x", roles: ["Pilot"], pilotId: "mem", clubId: "cA" };
    mockLoad(makeRound("Locked"));

    renderPage();

    await screen.findByRole("heading", { name: "Milk Hill" });
    const buttons = await screen.findAllByRole("button", { name: /accounted for/i });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Mark accounted for");
  });

  it("a pilot not in the round sees no accounted-for toggle", async () => {
    mockIdentity = { userId: "u", email: "z@x", roles: ["Pilot"], pilotId: "zzz", clubId: "cA" };
    mockLoad(makeRound("Locked"));

    renderPage();

    await screen.findByRole("heading", { name: "Milk Hill" });
    await waitFor(() => expect(screen.queryByText(/Mark accounted for/i)).not.toBeInTheDocument());
  });

  it("no toggle before the round is Locked (captain, BriefComplete)", async () => {
    mockIdentity = { userId: "u", email: "c@x", roles: ["Pilot"], pilotId: "cap", clubId: "cA" };
    mockLoad(makeRound("BriefComplete"));

    renderPage();

    await screen.findByRole("heading", { name: "Milk Hill" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /accounted for/i })).not.toBeInTheDocument(),
    );
  });
});

describe("RoundDetail — rescore success modal survives the post-mutation reload", () => {
  const COUNTS: RescoreJobCounts = {
    rescoredCount: 3,
    skippedManualCount: 1,
    skippedNoIgcCount: 2,
    skippedBudgetCount: 0,
    errorCount: 0,
  };

  function job(status: RescoreJobStatus, counts?: RescoreJobCounts): RescoreJob {
    return {
      jobId: "job-1",
      roundId: "r1",
      status,
      requestedByEmail: "a@x",
      requestedAt: "2026-06-09T10:00:00Z",
      ...(counts ? { counts } : {}),
    };
  }

  async function flushMicrotasks() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    mockIdentity = null;
  });

  it("keeps the rescore success modal mounted after a completed poll (no full-page reload)", async () => {
    vi.useFakeTimers();
    mockIdentity = { userId: "u", email: "a@x", roles: ["Admin"], pilotId: null, clubId: null };

    const round = makeRound("Locked");
    let roundFetchCount = 0;
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === "rounds/r1") {
        roundFetchCount += 1;
        // 1st call = initial load. The post-mutation reload (2nd call) stays
        // PENDING, modelling a real slow-network reload: on the buggy foreground
        // path `loading` latches true and unmounts the round subtree.
        return (roundFetchCount === 1
          ? Promise.resolve(round)
          : new Promise<never>(() => {})) as Promise<unknown>;
      }
      if (path === "rounds/r1/brief") {
        return Promise.reject(new ApiError(404, "NOT_FOUND", "no brief"));
      }
      if (path === "rounds/r1/rescore/job-1") {
        return Promise.resolve(job("completed", COUNTS)) as Promise<unknown>;
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    vi.mocked(api.post).mockResolvedValue({ jobId: "job-1", status: "queued" });

    renderPage();
    await flushMicrotasks();
    expect(screen.getByRole("heading", { name: "Milk Hill" })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("rescore-round-btn"));
    fireEvent.click(screen.getByTestId("rescore-confirm-yes"));
    await flushMicrotasks();

    // Completed poll: the button shows its success phase AND calls onChanged. A
    // foreground reload latches loading=true (reload pending), unmounting this
    // subtree and destroying the modal — the exact regression under lock.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByTestId("rescore-success-modal")).toBeInTheDocument();
    expect(screen.getByTestId("rescore-count-rescored")).toHaveTextContent("3");
    expect(screen.queryByText(/Loading round/i)).toBeNull();
    const roundFetches = vi.mocked(api.get).mock.calls.filter(([p]) => p === "rounds/r1");
    expect(roundFetches.length).toBeGreaterThanOrEqual(2);
  });
});
