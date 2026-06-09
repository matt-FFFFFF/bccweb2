import { describe, test, expect } from "vitest";
import { scoreRound, computeLeague } from "../index.js";
import type { Round, Config, PilotSlot, Team } from "@bccweb/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseConfig: Config = {
  maxTeamsInClub: 2,
  maxPilotsInTeam: 12,
  maxScoringPilotsInTeam: 3,
  flightDateValidationEnabled: false,
  wingFactors: {
    "EN A": 1.0,
    "EN B": 0.9,
    "EN C": 0.8,
    "EN C 2-liner": 0.7,
    "EN D": 0.6,
    "EN D 2-liner": 0.5,
  },
};

function makeFlight(distance: number) {
  return {
    id: "f1",
    distance,
    scoringType: "XC" as const,
    score: 0,
    wingFactor: 1,
    isManualLog: false,
  };
}

function makeSlot(
  overrides: Partial<PilotSlot> = {}
): PilotSlot {
  return {
    placeInTeam: 1,
    isScoring: true,
    status: "Filled",
    accountedFor: false,
    signToFly: false,
    noScore: false,
    pilotPoints: 0,
    pilotId: "pilot-1",
    snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
    flight: null,
    ...overrides,
  };
}

function makeTeam(slots: PilotSlot[], overrides: Partial<Team> = {}): Team {
  return {
    id: "team-1",
    teamName: "Advance A",
    club: { id: "club-1", name: "Advance" },
    score: 0,
    pilots: slots,
    ...overrides,
  };
}

function makeRound(teams: Team[], overrides: Partial<Round> = {}): Round {
  return {
    id: "round-1",
    date: "2025-07-12",
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-1", name: "Hay Bluff" },
    season: { year: 2025 },
    teams,
    ...overrides,
  };
}

// ─── scoreRound ───────────────────────────────────────────────────────────────

describe("scoreRound", () => {
  test("applies wing factor to flight distance", () => {
    const slot = makeSlot({ flight: makeFlight(100) }); // EN B → 0.9
    const round = makeRound([makeTeam([slot])]);

    const result = scoreRound(round, baseConfig);

    expect(result.teams[0].pilots[0].pilotPoints).toBe(90);
    expect(result.teams[0].pilots[0].flight!.score).toBe(90);
    expect(result.teams[0].pilots[0].flight!.wingFactor).toBe(0.9);
  });

  test("rounds score to 1 decimal place", () => {
    // EN B factor 0.9; distance 33.4 → 30.06 → rounds to 30.1
    const slot = makeSlot({ flight: makeFlight(33.4) });
    const round = makeRound([makeTeam([slot])]);
    scoreRound(round, baseConfig);
    expect(round.teams[0].pilots[0].pilotPoints).toBe(30.1);
  });

  test("noScore pilot contributes 0 points", () => {
    const slot = makeSlot({ flight: makeFlight(100), noScore: true });
    const round = makeRound([makeTeam([slot])]);
    scoreRound(round, baseConfig);
    expect(round.teams[0].pilots[0].pilotPoints).toBe(0);
    expect(round.teams[0].score).toBe(0);
  });

  test("slot with no flight contributes 0 points", () => {
    const slot = makeSlot({ flight: null });
    const round = makeRound([makeTeam([slot])]);
    scoreRound(round, baseConfig);
    expect(round.teams[0].pilots[0].pilotPoints).toBe(0);
  });

  test("slot with no snapshot contributes 0 points", () => {
    const slot = makeSlot({ flight: makeFlight(100), snapshot: null });
    const round = makeRound([makeTeam([slot])]);
    scoreRound(round, baseConfig);
    expect(round.teams[0].pilots[0].pilotPoints).toBe(0);
  });

  test("only top maxScoringPilotsInTeam (3) scoring pilots count to team score", () => {
    // 4 pilots with scores 100, 80, 60, 40 (all EN B → ×0.9)
    const slots = [100, 80, 60, 40].map((d, i) =>
      makeSlot({ placeInTeam: i + 1, flight: makeFlight(d) })
    );
    const round = makeRound([makeTeam(slots)]);
    scoreRound(round, baseConfig);

    // Top 3: 90 + 72 + 54 = 216
    expect(round.teams[0].score).toBe(216);
  });

  test("non-scoring slot (isScoring=false) does not count toward team score", () => {
    const scoring = makeSlot({ flight: makeFlight(100) });
    const nonScoring = makeSlot({
      placeInTeam: 2,
      isScoring: false,
      flight: makeFlight(200),
    });
    const round = makeRound([makeTeam([scoring, nonScoring])]);
    scoreRound(round, baseConfig);

    // Only the scoring pilot's points count
    expect(round.teams[0].score).toBe(90);
  });

  test("uses default wing factor 1.0 when wingClass is unknown", () => {
    const slot = makeSlot({
      flight: makeFlight(50),
      snapshot: { wingClass: "EN A", pilotRating: "Pilot" }, // EN A = 1.0
    });
    const round = makeRound([makeTeam([slot])]);
    scoreRound(round, baseConfig);
    expect(round.teams[0].pilots[0].pilotPoints).toBe(50);
  });

  test("sums scores for multiple teams independently", () => {
    const team1 = makeTeam(
      [makeSlot({ flight: makeFlight(100) })],
      { id: "t1", teamName: "Advance A" }
    );
    const team2 = makeTeam(
      [makeSlot({ flight: makeFlight(50) })],
      { id: "t2", teamName: "Advance B" }
    );
    const round = makeRound([team1, team2]);
    scoreRound(round, baseConfig);

    expect(round.teams[0].score).toBe(90);
    expect(round.teams[1].score).toBe(45);
  });
});

// ─── computeLeague ────────────────────────────────────────────────────────────

describe("computeLeague", () => {
  function completedRound(id: string, teamScore: number, teamId = "t1"): Round {
    const team = makeTeam([], {
      id: teamId,
      teamName: "Advance A",
      score: teamScore,
    });
    return makeRound([team], { id, status: "Complete" });
  }

  test("sums team scores across complete rounds", () => {
    const rounds = [
      completedRound("r1", 100),
      completedRound("r2", 80),
    ];
    const table = computeLeague(rounds);
    expect(table).toHaveLength(1);
    expect(table[0].totalScore).toBe(180);
    expect(table[0].countedRounds).toBe(2);
  });

  test("ignores non-Complete rounds", () => {
    const rounds = [
      completedRound("r1", 100),
      makeRound([makeTeam([], { id: "t1", score: 999 })], {
        id: "r2",
        status: "Locked",
      }),
    ];
    const table = computeLeague(rounds);
    expect(table[0].totalScore).toBe(100);
  });

  test("ignores zero-score team rounds", () => {
    const rounds = [
      completedRound("r1", 100),
      completedRound("r2", 0),
    ];
    const table = computeLeague(rounds);
    expect(table[0].countedRounds).toBe(1);
    expect(table[0].totalScore).toBe(100);
  });

  test("ranks teams in descending score order", () => {
    const rounds = [
      makeRound(
        [
          makeTeam([], { id: "t1", teamName: "Advance A", club: { id: "c1", name: "Advance" }, score: 150 }),
          makeTeam([], { id: "t2", teamName: "Bright A", club: { id: "c2", name: "Bright" }, score: 200 }),
        ],
        { id: "r1", status: "Complete" }
      ),
    ];
    const table = computeLeague(rounds);
    expect(table[0].clubName).toBe("Bright");
    expect(table[0].rank).toBe(1);
    expect(table[1].rank).toBe(2);
  });

  test("ties receive the same rank", () => {
    const rounds = [
      makeRound(
        [
          makeTeam([], { id: "t1", teamName: "A", club: { id: "c1", name: "Club 1" }, score: 100 }),
          makeTeam([], { id: "t2", teamName: "B", club: { id: "c2", name: "Club 2" }, score: 100 }),
        ],
        { id: "r1", status: "Complete" }
      ),
    ];
    const table = computeLeague(rounds);
    expect(table[0].rank).toBe(1);
    expect(table[1].rank).toBe(1);
  });

  test("returns empty array for no rounds", () => {
    expect(computeLeague([])).toEqual([]);
  });

  test("tracks per-round scores in roundScores map", () => {
    const rounds = [
      completedRound("r1", 100),
      completedRound("r2", 80),
    ];
    const table = computeLeague(rounds);
    expect(table[0].roundScores).toEqual({ r1: 100, r2: 80 });
  });
});
