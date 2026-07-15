// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Config, Round, Team, PilotSlot } from "@bccweb/types";
import { describe, expect, it } from "vitest";

import { computeLeague, scoreRound } from "../index.js";

const baseConfig: Config = {
  maxTeamsInClub: 2,
  maxPilotsInTeam: 9,
  maxScoringPilotsInTeam: 6,
  maxPilotScoresCountedPerTeam: 4,
  leagueRoundScoresCounted: 6,
  flightDateValidationEnabled: true,
  flightSignatureValidationEnabled: false,
  roundBriefRecipients: [],
  wingFactors: {
    "EN A": 1,
    "EN B": 0.9,
    "EN C": 0.8,
    "EN C 2-liner": 0.7,
    "EN D": 0.6,
    "EN D 2-liner": 0.5,
  },
  taskMaxPoints: 1000,
  pilotFactors: {
    "Club Pilot": 1,
    Pilot: 1,
    "Advanced Pilot": 0.9,
  },
  clubsAttendingFactors: {
    fewerThanThreeClubs: 0.5,
    exactlyThreeClubs: 0.75,
    moreThanThreeClubs: 1,
  },
  minDistanceFactors: {
    oneFlight: 0.2,
    twoFlights: 0.4,
    threeFlights: 0.6,
    fourFlights: 0.8,
    fiveOrMoreFlights: 1,
  },
};

function makeSlot(
  placeInTeam: number,
  distance: number,
  overrides: Partial<PilotSlot> = {}
): PilotSlot {
  return {
    placeInTeam,
    isScoring: true,
    status: "Filled",
    accountedFor: true,
    signToFly: true,
    noScore: false,
    pilotPoints: 0,
    pilotId: `pilot-${placeInTeam}`,
    snapshot: { wingClass: "EN A", pilotRating: "Pilot" },
    flight: {
      id: `flight-${placeInTeam}`,
      distance,
      scoringType: "XC",
      score: 0,
      wingFactor: 0,
      isManualLog: false,
    },
    ...overrides,
  };
}

function makeTeam(slots: PilotSlot[], overrides: Partial<Team> = {}): Team {
  return {
    id: "team-1",
    teamName: "Oracle Alpha",
    club: { id: "club-1", name: "Oracle Club One" },
    score: 0,
    pilots: slots,
    ...overrides,
  };
}

function makeRound(teams: Team[], overrides: Partial<Round> = {}): Round {
  return {
    id: "round-1",
    date: "2026-07-06",
    status: "Complete",
    isLocked: true,
    maxTeams: 12,
    minimumScore: 5,
    site: { id: "site-1", name: "Oracle Site" },
    season: { year: 2026 },
    teams,
    ...overrides,
  };
}

function completedRound(id: string, teamScore: number): Round {
  return makeRound([makeTeam([], { score: teamScore })], { id, status: "Complete" });
}

describe("scoreRound", () => {
  it("normalizes a single scoring pilot to maxPointsForRound", () => {
    const round = makeRound([makeTeam([makeSlot(1, 42)])]);

    const { round: scoredRound, derivation } = scoreRound(round, baseConfig);

    // BaseController.cs:2254-2309,2465: 1000 * 0.5 clubs * 0.2 one-flight = 100.
    expect(derivation.maxPointsForRound).toBeCloseTo(100, 5);
    // BaseController.cs:2336: best raw pilot score receives maxPointsForRound.
    expect(scoredRound.teams[0]?.pilots[0]?.pilotPoints).toBeCloseTo(100, 5);
    // BaseController.cs:2424: best working team score receives maxPointsForRound rounded 0dp.
    expect(scoredRound.teams[0]?.score).toBe(100);
  });

  it("applies the Advanced Pilot factor before pilot normalization", () => {
    const round = makeRound([
      makeTeam([
        makeSlot(1, 100),
        makeSlot(2, 100, {
          pilotId: "advanced-pilot",
          snapshot: { wingClass: "EN A", pilotRating: "Advanced Pilot" },
        }),
      ]),
    ]);

    const { round: scoredRound } = scoreRound(round, baseConfig);

    // BaseController.cs:1661-1678: Advanced Pilot factor is 0.9, raw score 100 * 0.9 * 1 = 90.
    expect(scoredRound.teams[0]?.pilots[1]?.flight?.score).toBeCloseTo(90, 5);
    // BaseController.cs:2336: 200 maxPointsForRound * 90 / 100 = 180.
    expect(scoredRound.teams[0]?.pilots[1]?.pilotPoints).toBeCloseTo(180, 5);
  });

  it("counts top four pilot points even when six scoring slots are eligible", () => {
    const alpha = makeTeam([60, 50, 40, 30, 20, 10].map((distance, index) => makeSlot(index + 1, distance)));
    const beta = makeTeam(
      [60, 50, 40, 29].map((distance, index) => makeSlot(index + 1, distance)),
      { id: "team-2", teamName: "Oracle Beta", club: { id: "club-2", name: "Oracle Club Two" } }
    );
    const round = makeRound([alpha, beta]);

    const { round: scoredRound, derivation } = scoreRound(round, baseConfig);

    // BaseController.cs:2359-2380: top four only; top six would include 166.66667 + 83.333336 too.
    expect(derivation.teams.find((team) => team.teamId === "team-1")?.workingTeamScore).toBe(1500);
    expect(derivation.maxTeamScore).toBe(1500);
    // BaseController.cs:2424: beta is normalized against alpha's top-four total, not alpha's top-six total.
    expect(scoredRound.teams[1]?.score).toBe(497);
  });

  it("excludes non-scoring and beyond-eligible slots from the working team score", () => {
    const round = makeRound([
      makeTeam([
        makeSlot(1, 100),
        makeSlot(7, 200, { isScoring: false, pilotId: "beyond-eligible" }),
      ]),
    ]);

    const { round: scoredRound, derivation } = scoreRound(round, baseConfig);

    // BaseController.cs:2357-2380: IsScoring=false slots still get pilot points but are excluded from WorkingTeamScore.
    expect(scoredRound.teams[0]?.pilots[1]?.pilotPoints).toBeCloseTo(200, 5);
    expect(derivation.teams[0]?.workingTeamScore).toBe(100);
  });

  it("scores healed default wing snapshots as EN A instead of unknown-wing zero", () => {
    const round = makeRound([
      makeTeam([
        makeSlot(1, 50, {
          snapshot: { wingClass: "EN A", pilotRating: "Pilot" },
        }),
      ]),
    ]);

    const { round: scoredRound } = scoreRound(round, baseConfig);

    // D8/BaseController.cs:1631-1659: schemas heal malformed stored wingClass to EN A, so factor is 1 not legacy unknown 0.
    expect(scoredRound.teams[0]?.pilots[0]?.flight?.wingFactor).toBe(1);
    expect(scoredRound.teams[0]?.pilots[0]?.pilotPoints).toBeCloseTo(100, 5);
  });

  it("keeps all-zero rounds at zero", () => {
    const round = makeRound([makeTeam([makeSlot(1, 0)])], { minimumScore: 0 });

    const { round: scoredRound, derivation } = scoreRound(round, baseConfig);

    // D9/BaseController.cs:2330-2336: legacy is unguarded for max raw score 0; this port keeps zeros.
    expect(derivation.maxPilotScoreInRound).toBe(0);
    expect(scoredRound.teams[0]?.pilots[0]?.pilotPoints).toBe(0);
    expect(scoredRound.teams[0]?.score).toBe(0);
  });

  it("scores a noScore slot that still has a flight (legacy removes the flight, not the score)", () => {
    const round = makeRound([
      makeTeam([
        makeSlot(1, 100, { noScore: true }),
        makeSlot(2, 50),
      ]),
    ]);

    const { round: scoredRound, derivation } = scoreRound(round, baseConfig);

    // Legacy has NO noScore check (BaseController.cs:2311-2368); no-score is enforced by flight removal, so a dirty noScore+flight slot is still scored. Locks against re-adding a slot.noScore skip.
    expect(derivation.maxPilotScoreInRound).toBeCloseTo(100, 5);
    expect(scoredRound.teams[0]?.pilots[0]?.pilotPoints).toBeCloseTo(200, 5);
    expect(scoredRound.teams[0]?.pilots[1]?.pilotPoints).toBeCloseTo(100, 5);
  });
});

describe("computeLeague", () => {
  it("takes the top six complete-round scores and truncates the season total", () => {
    const rounds = [
      completedRound("r1", 100.9),
      completedRound("r2", 90.9),
      completedRound("r3", 80.9),
      completedRound("r4", 70.9),
      completedRound("r5", 60.9),
      completedRound("r6", 50.9),
      completedRound("r7", 40.9),
    ];

    const table = computeLeague(rounds, baseConfig);

    // ResultsController.cs:198-251: OrderByDescending().Take(6), then (int)Sum.
    expect(table[0]?.totalScore).toBe(455);
    expect(table[0]?.countedRounds).toBe(6);
    expect(table[0]?.roundScores).not.toHaveProperty("r7");
  });

  it("groups complete rounds by club and team name with ordinal ranks", () => {
    const rounds = [
      makeRound(
        [
          makeTeam([], { score: 100 }),
          makeTeam([], {
            id: "team-2",
            teamName: "Oracle Beta",
            club: { id: "club-2", name: "Oracle Club Two" },
            score: 100,
          }),
        ],
        { id: "r1", status: "Complete" }
      ),
      makeRound([makeTeam([], { score: 999 })], { id: "locked", status: "Locked" }),
    ];

    const table = computeLeague(rounds, baseConfig);

    // ResultsController.cs:228-251: rows are ordered by total score and ranks are ordinal, not competition ties.
    expect(table.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(table.map((entry) => entry.totalScore)).toEqual([100, 100]);
  });
});
