// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { scoreRound } from "@bccweb/scoring";
import type { Config, Flight, PilotSlot, Round, Team } from "@bccweb/types";
import { describe, expect, it, vi } from "vitest";

import {
  isFlightDisqualified,
  scoreRoundEnforcingValidation,
} from "../scoreRoundValidated.js";

vi.mock("@bccweb/scoring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bccweb/scoring")>();
  return { ...actual, scoreRound: vi.fn(actual.scoreRound) };
});

const baseConfig: Config = {
  maxTeamsInClub: 2,
  maxPilotsInTeam: 9,
  maxScoringPilotsInTeam: 6,
  maxPilotScoresCountedPerTeam: 4,
  leagueRoundScoresCounted: 6,
  flightDateValidationEnabled: true,
  flightSignatureValidationEnabled: true,
  roundBriefRecipients: [],
  wingFactors: {
    "EN A": 1,
    "EN B": 0.9,
    "EN C": 0.8,
    "EN C 2-liner": 0.7,
    "EN D": 0.6,
    "EN D 2-liner": 0.5,
  },
  taskMaxPoints: 1_000,
  pilotFactors: { "Club Pilot": 1, Pilot: 1, "Advanced Pilot": 0.9 },
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

function makeFlight(placeInTeam: number, overrides: Partial<Flight> = {}): Flight {
  return {
    id: `flight-${placeInTeam}`,
    distance: 20 + placeInTeam * 10,
    scoringType: "XC",
    score: 123,
    wingFactor: 0.75,
    isManualLog: false,
    igcPath: `flight-igcs/round-1/pilot-${placeInTeam}.igc`,
    ...overrides,
  };
}

function makeSlot(placeInTeam: number, flight = makeFlight(placeInTeam)): PilotSlot {
  return {
    placeInTeam,
    isScoring: true,
    status: "Filled",
    accountedFor: true,
    signToFly: true,
    noScore: false,
    pilotPoints: 99,
    pilotId: `pilot-${placeInTeam}`,
    snapshot: { wingClass: "EN A", pilotRating: "Pilot" },
    flight,
  };
}

function makeTeam(slots: PilotSlot[], id = "team-1"): Team {
  return {
    id,
    teamName: id,
    club: { id: `club-${id}`, name: `Club ${id}` },
    score: 0,
    pilots: slots,
  };
}

function makeRound(firstFlight = makeFlight(1), secondFlight = makeFlight(2)): Round {
  return {
    id: "round-1",
    date: "2026-07-06",
    status: "Complete",
    isLocked: true,
    maxTeams: 12,
    minimumScore: 5,
    site: { id: "site-1", name: "Oracle Site" },
    season: { year: 2026 },
    teams: [makeTeam([makeSlot(1, firstFlight), makeSlot(2, secondFlight)])],
  };
}

function scoringOutputs(round: Round): object {
  return {
    teamScores: round.teams.map((team) => team.score),
    pilotPoints: round.teams.map((team) => team.pilots.map((slot) => slot.pilotPoints)),
  };
}

function expectMatchesNullFlightBaseline(round: Round, config: Config): void {
  const baseline = structuredClone(round);
  const baselineSlot = baseline.teams[0]?.pilots[0];
  if (baselineSlot) baselineSlot.flight = null;

  const expected = scoreRound(baseline, config);
  const actual = scoreRoundEnforcingValidation(round, config);

  expect(scoringOutputs(actual.round)).toEqual(scoringOutputs(expected.round));
  expect(actual.derivation).toEqual(expected.derivation);
}

describe("isFlightDisqualified", () => {
  it("requires an enabled current toggle, invalid metadata, and no override or manual log", () => {
    const invalid = makeFlight(1, { validation: { signature: "invalid" } });

    expect(isFlightDisqualified(invalid, baseConfig)).toBe(true);
    expect(isFlightDisqualified({ ...invalid, isManualLog: true }, baseConfig)).toBe(false);
    expect(
      isFlightDisqualified({ ...invalid, validation: { signature: "invalid", overridden: true } }, baseConfig),
    ).toBe(false);
    expect(
      isFlightDisqualified(invalid, { ...baseConfig, flightSignatureValidationEnabled: false }),
    ).toBe(false);
  });
});

describe("scoreRoundEnforcingValidation", () => {
  it.each([
    ["signature", { signature: "invalid" }],
    ["date", { date: "invalid" }],
  ] as const)("matches a null-flight baseline for an invalid %s", (_kind, validation) => {
    const flight = makeFlight(1, { validation });
    const round = makeRound(flight);
    const originalDistance = flight.distance;
    const originalPath = flight.igcPath;

    expectMatchesNullFlightBaseline(round, baseConfig);

    const restoredSlot = round.teams[0]?.pilots[0];
    expect(restoredSlot?.flight).toBe(flight);
    expect(restoredSlot?.flight?.score).toBe(0);
    expect(restoredSlot?.flight?.wingFactor).toBe(0);
    expect(restoredSlot?.pilotPoints).toBe(0);
    expect(restoredSlot?.flight?.distance).toBe(originalDistance);
    expect(restoredSlot?.flight?.igcPath).toBe(originalPath);
    expect(restoredSlot?.flight?.validation).toEqual(validation);
  });

  it("scores an overridden invalid flight normally", () => {
    const round = makeRound(
      makeFlight(1, { validation: { signature: "invalid", overridden: true } }),
    );
    const baseline = structuredClone(round);

    const actual = scoreRoundEnforcingValidation(round, baseConfig);
    const expected = scoreRound(baseline, baseConfig);

    expect(scoringOutputs(actual.round)).toEqual(scoringOutputs(expected.round));
    expect(actual.derivation).toEqual(expected.derivation);
    expect(actual.round.teams[0]?.pilots[0]?.flight?.score).toBeGreaterThan(0);
  });

  it.each([
    ["signature", makeFlight(1, { validation: { signature: "invalid" } }), { flightSignatureValidationEnabled: false }],
    ["date", makeFlight(1, { validation: { date: "invalid" } }), { flightDateValidationEnabled: false }],
  ] as const)("scores an invalid %s normally when its toggle is off", (_kind, flight, toggle) => {
    const config = { ...baseConfig, ...toggle };
    const round = makeRound(flight);
    const expected = scoreRound(structuredClone(round), config);

    const actual = scoreRoundEnforcingValidation(round, config);

    expect(scoringOutputs(actual.round)).toEqual(scoringOutputs(expected.round));
    expect(actual.derivation).toEqual(expected.derivation);
    expect(actual.round.teams[0]?.pilots[0]?.flight?.score).toBeGreaterThan(0);
  });

  it.each([
    ["unverified", makeFlight(1, { validation: { signature: "unverified" } })],
    ["pending", makeFlight(1, { validation: { signature: "pending" } })],
    ["absent", makeFlight(1)],
  ] as const)("keeps the raw derivation byte-identical for %s validation", (_kind, flight) => {
    const round = makeRound(flight);
    const expected = scoreRound(structuredClone(round), baseConfig);

    const actual = scoreRoundEnforcingValidation(round, baseConfig);

    expect(JSON.stringify(actual.derivation)).toBe(JSON.stringify(expected.derivation));
    expect(scoringOutputs(actual.round)).toEqual(scoringOutputs(expected.round));
  });

  it("scores a manual flight carrying stale invalid validation", () => {
    const round = makeRound(
      makeFlight(1, { isManualLog: true, validation: { signature: "invalid", date: "invalid" } }),
    );
    const expected = scoreRound(structuredClone(round), baseConfig);

    const actual = scoreRoundEnforcingValidation(round, baseConfig);

    expect(scoringOutputs(actual.round)).toEqual(scoringOutputs(expected.round));
    expect(actual.derivation).toEqual(expected.derivation);
    expect(actual.round.teams[0]?.pilots[0]?.flight?.score).toBeGreaterThan(0);
  });

  it("restores every disqualified flight when scoring throws", () => {
    const signatureFlight = makeFlight(1, { validation: { signature: "invalid" } });
    const dateFlight = makeFlight(2, { validation: { date: "invalid" } });
    const round = makeRound(signatureFlight, dateFlight);
    vi.mocked(scoreRound).mockImplementationOnce(() => {
      throw new TypeError("forced scoring failure");
    });

    expect(() => scoreRoundEnforcingValidation(round, baseConfig)).toThrow(TypeError);

    expect(round.teams[0]?.pilots[0]?.flight).toBe(signatureFlight);
    expect(round.teams[0]?.pilots[1]?.flight).toBe(dateFlight);
    for (const slot of round.teams[0]?.pilots ?? []) {
      expect(slot.flight?.score).toBe(0);
      expect(slot.flight?.wingFactor).toBe(0);
      expect(slot.pilotPoints).toBe(0);
    }
  });
});
