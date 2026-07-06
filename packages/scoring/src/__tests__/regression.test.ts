/// <reference types="node" />

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface LegacyOracleFixture {
  name: string;
  scenario: string;
  legacySource: string;
  legacyId: null;
  legacyIdNote: string;
  capturedAt: string;
  input: {
    round: { id: string };
    config: unknown;
    seasonRounds?: readonly unknown[];
  };
  expected: {
    round: unknown;
    pilots: readonly unknown[];
    teams: readonly unknown[];
    league: readonly unknown[];
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

    for (const { fileName, text } of readFixtureFiles()) {
      const fixture = JSON.parse(text) as Partial<LegacyOracleFixture>;
      expect(fixture.legacySource, `${fileName} must carry legacySource`).toBeDefined();
      for (const marker of forbiddenMarkers) {
        expect(text.includes(marker), `${fileName} contains old-model marker ${marker}`).toBe(
          false
        );
      }
    }
  });
});
