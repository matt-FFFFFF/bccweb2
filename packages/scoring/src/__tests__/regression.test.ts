// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/// <reference types="node" />

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Round } from "@bccweb/types";
import { describe, expect, it } from "vitest";

import { computeLeague, scoreRound } from "../index.js";

interface LegacyRoundExpected {
  maxPointsForRound: number;
  maxPilotScoreInRound: number;
  maxTeamScore: number;
  clubsAttendingCount: number;
  clubsAttendingFactor: number;
  minDistanceFlightCount: number;
  minDistanceFactor: number;
}

interface LegacyPilotExpected {
  teamId: string;
  placeInTeam: number;
  pilotPoints: number;
}

interface LegacyTeamExpected {
  teamId: string;
  score: number;
}

interface LegacyLeagueExpected {
  clubId: string;
  teamName: string;
  totalScore: number;
  rank: number;
  countedRounds: number;
  roundScores: Record<string, number>;
}

interface LegacyOracleFixture {
  name: string;
  scenario: string;
  legacySource: string;
  legacyId: null;
  legacyIdNote: string;
  capturedAt: string;
  input: {
    round: Round;
    config: Config;
    seasonRounds?: readonly Round[];
  };
  expected: {
    round: LegacyRoundExpected;
    pilots: readonly LegacyPilotExpected[];
    teams: readonly LegacyTeamExpected[];
    league: readonly LegacyLeagueExpected[];
  };
}

type LegacyScoreManifest = Record<
  string,
  Record<
    string,
    {
      teamScore: number;
      workingTeamScore: number;
      pilots: Record<string, number>;
    }
  >
>;

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixturesDir = join(fixturesRoot, "legacy-rounds");
const manifestPath = join(fixturesRoot, "legacy-score-manifest.json");

function readFixtureFiles(): readonly { fileName: string; text: string }[] {
  return readdirSync(fixturesDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      fileName,
      text: readFileSync(join(fixturesDir, fileName), "utf8"),
    }));
}

function readFixtures(): readonly LegacyOracleFixture[] {
  return readFixtureFiles().map(({ text }) => JSON.parse(text) as LegacyOracleFixture);
}

function readManifest(): LegacyScoreManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as LegacyScoreManifest;
}

const fixtureFiles = readFixtureFiles();
const fixtureCases = fixtureFiles.map(({ fileName, text }) => [fileName, text] as const);

function readFixture(text: string): LegacyOracleFixture {
  return JSON.parse(text) as LegacyOracleFixture;
}

function assertRoundMatchesOracle(fixture: LegacyOracleFixture): void {
  const round = structuredClone(fixture.input.round);
  const { derivation } = scoreRound(round, fixture.input.config);

  for (const expectedPilot of fixture.expected.pilots) {
    const actualPilot = round.teams
      .find((team) => team.id === expectedPilot.teamId)
      ?.pilots.find((pilot) => pilot.placeInTeam === expectedPilot.placeInTeam);

    expect(
      actualPilot?.pilotPoints,
      `${fixture.name} pilot ${expectedPilot.teamId}/${expectedPilot.placeInTeam}`
    ).toBeCloseTo(expectedPilot.pilotPoints, 1);
  }

  for (const expectedTeam of fixture.expected.teams) {
    const actualTeam = round.teams.find((team) => team.id === expectedTeam.teamId);
    expect(actualTeam?.score, `${fixture.name} team ${expectedTeam.teamId}`).toBe(
      expectedTeam.score
    );
  }

  expect(derivation.maxPointsForRound).toBeCloseTo(
    fixture.expected.round.maxPointsForRound,
    4
  );
  expect(derivation.maxPilotScoreInRound).toBeCloseTo(
    fixture.expected.round.maxPilotScoreInRound,
    4
  );
  expect(derivation.clubsAttendingFactor).toBeCloseTo(
    fixture.expected.round.clubsAttendingFactor,
    4
  );
  expect(derivation.minDistanceFactor).toBeCloseTo(
    fixture.expected.round.minDistanceFactor,
    4
  );
  expect(derivation.maxTeamScore).toBe(fixture.expected.round.maxTeamScore);
  expect(derivation.clubsAttendingCount).toBe(
    fixture.expected.round.clubsAttendingCount
  );
  expect(derivation.minDistanceFlightCount).toBe(
    fixture.expected.round.minDistanceFlightCount
  );
}

function assertLeagueMatchesOracle(fixture: LegacyOracleFixture): void {
  const seasonRounds = fixture.input.seasonRounds ?? [fixture.input.round];
  const scoredSeason = seasonRounds.map((inputRound) => {
    const round = structuredClone(inputRound);
    scoreRound(round, fixture.input.config);
    return round;
  });

  const league = computeLeague(scoredSeason, fixture.input.config);
  expect(league).toHaveLength(fixture.expected.league.length);

  for (const expectedTeam of fixture.expected.league) {
    const actualTeam = league.find(
      (team) =>
        team.teamName === expectedTeam.teamName && team.clubId === expectedTeam.clubId
    );

    expect(
      actualTeam,
      `${fixture.name} league ${expectedTeam.clubId}/${expectedTeam.teamName}`
    ).toBeDefined();
    expect(actualTeam?.totalScore).toBe(expectedTeam.totalScore);
    expect(actualTeam?.rank).toBe(expectedTeam.rank);
    expect(actualTeam?.countedRounds).toBe(expectedTeam.countedRounds);

    const actualRoundScores = actualTeam?.roundScores ?? {};
    const actualRoundIds = Object.keys(actualRoundScores).sort();
    const expectedRoundIds = Object.keys(expectedTeam.roundScores).sort();
    expect(actualRoundIds).toEqual(expectedRoundIds);

    for (const roundId of expectedRoundIds) {
      expect(actualRoundScores[roundId], `${fixture.name} ${expectedTeam.teamName} ${roundId}`).toBe(
        expectedTeam.roundScores[roundId]
      );
    }
  }
}

describe("legacy scoring oracle fixtures", () => {
  it("fixtures load with provenance", () => {
    const fixtures = readFixtures();
    const manifest = readManifest();

    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    for (const fixture of fixtures) {
      expect(fixture.legacySource).toMatch(
        /^net10-verbatim-copy-of-BaseController\.cs@[0-9a-f]{40}$/
      );
      expect(Date.parse(fixture.capturedAt)).not.toBeNaN();
      expect(fixture.legacyId).toBeNull();
      expect(fixture.legacyIdNote).toContain("Algorithm-derived oracle fixture");
      expect(fixture.expected.round).toBeDefined();
      expect(fixture.expected.pilots.length).toBeGreaterThan(0);
      expect(fixture.expected.teams.length).toBeGreaterThan(0);
      expect(fixture.expected.league.length).toBeGreaterThan(0);
      expect(manifest[fixture.input.round.id]).toBeDefined();
    }
  });

  it("no synthetic or old-model fixture remains", () => {
    const forbiddenMarkers = [
      "synthetic-handcrafted",
      "round1dp",
      "round1(",
      "score = round1(distance * wingFactor)",
    ] as const;

    for (const { fileName, text } of fixtureFiles) {
      const fixture = JSON.parse(text) as Partial<LegacyOracleFixture>;
      expect(fixture.legacySource, `${fileName} must carry legacySource`).toBeDefined();
      for (const marker of forbiddenMarkers) {
        expect(text.includes(marker), `${fileName} contains old-model marker ${marker}`).toBe(
          false
        );
      }
    }
  });

  describe.each(fixtureCases)("%s", (fileName, text) => {
    const fixture = readFixture(text);

    it(`${fileName} matches legacy round scoring`, () => {
      assertRoundMatchesOracle(fixture);
    });

    it(`${fileName} matches legacy league scoring`, () => {
      assertLeagueMatchesOracle(fixture);
    });
  });
});
