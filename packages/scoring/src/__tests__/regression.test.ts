import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Config, Round } from "@bccweb/types";
import { computeLeague, scoreRound } from "../index.js";

const PILOT_SCORE_TOLERANCE = 0.05;
const TEAM_SCORE_TOLERANCE = 0.1;

interface LegacyRoundFixture {
  name: string;
  notes: string;
  input: {
    round: Round;
    config: Config;
  };
  expected: {
    teamScores: Array<{ teamId: string; score: number }>;
    pilotScores: Array<{ pilotId: string; totalScore: number }>;
    leagueAfter: Array<{ teamId: string; position: number; score: number }>;
  };
}

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "legacy-rounds"
);

function readFixtures(): LegacyRoundFixture[] {
  return readdirSync(fixturesDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => {
      const json = readFileSync(join(fixturesDir, fileName), "utf8");
      return JSON.parse(json) as LegacyRoundFixture;
    });
}

function scoredPilots(round: Round): Map<string, number> {
  const scores = new Map<string, number>();

  for (const team of round.teams) {
    for (const slot of team.pilots) {
      if (slot.pilotId) {
        scores.set(slot.pilotId, slot.pilotPoints);
      }
    }
  }

  return scores;
}

function leagueByTeamId(round: Round): Map<string, { position: number; score: number }> {
  const teamKeyToId = new Map(
    round.teams.map((team) => [`${team.club.id}|${team.teamName}`, team.id])
  );
  const league = computeLeague([round]);
  const byTeamId = new Map<string, { position: number; score: number }>();

  for (const entry of league) {
    const teamId = teamKeyToId.get(`${entry.clubId}|${entry.teamName}`);
    if (teamId) {
      byTeamId.set(teamId, {
        position: entry.rank,
        score: entry.totalScore,
      });
    }
  }

  return byTeamId;
}

describe("legacy scoring regression fixtures", () => {
  const fixtures = readFixtures();

  expect(fixtures.length).toBeGreaterThanOrEqual(5);
  expect(fixtures.length).toBeLessThanOrEqual(10);

  for (const fixture of fixtures) {
    it(`matches legacy fixture ${fixture.name}`, () => {
      const round = structuredClone(fixture.input.round);
      const scoredRound = scoreRound(round, fixture.input.config);
      const pilotScores = scoredPilots(scoredRound);

      // Pilot tolerance is ±0.05 to match legacy 1-decimal output rounding.
      for (const expected of fixture.expected.pilotScores) {
        const actual = pilotScores.get(expected.pilotId);
        expect(actual, `missing pilot ${expected.pilotId}`).toBeDefined();
        expect(
          Math.abs((actual ?? 0) - expected.totalScore) < PILOT_SCORE_TOLERANCE,
          `pilot ${expected.pilotId}: expected ${expected.totalScore}, got ${actual}`
        ).toBe(true);
      }

      for (const expected of fixture.expected.teamScores) {
        const actual = scoredRound.teams.find((team) => team.id === expected.teamId)?.score;
        expect(actual, `missing team ${expected.teamId}`).toBeDefined();
        // Team tolerance is ±0.1 to allow sum-of-1-decimal drift from legacy exports.
        expect(
          Math.abs((actual ?? 0) - expected.score) < TEAM_SCORE_TOLERANCE,
          `team ${expected.teamId}: expected ${expected.score}, got ${actual}`
        ).toBe(true);
      }

      const league = leagueByTeamId(scoredRound);
      for (const expected of fixture.expected.leagueAfter) {
        const actual = league.get(expected.teamId);
        expect(actual, `missing league entry for team ${expected.teamId}`).toBeDefined();
        expect(
          Math.abs((actual?.score ?? 0) - expected.score) < TEAM_SCORE_TOLERANCE,
          `league team ${expected.teamId}: expected score ${expected.score}, got ${actual?.score}`
        ).toBe(true);
        expect(actual?.position).toBe(expected.position);
      }
    });
  }
});
