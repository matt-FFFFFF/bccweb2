// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";

import { LeagueEntrySchema, SeasonSchema, SeasonSummarySchema } from "../season.js";

const validLeagueEntry = {
  rank: 1,
  clubId: "club-1",
  clubName: "North Club",
  teamName: "North A",
  totalScore: 1234.5,
  roundScores: { "round-1": 600, "round-2": 634.5 },
  countedRounds: 2,
} as const;

const validSeason = {
  id: "season-2026",
  year: 2026,
  active: true,
  rounds: ["round-1", "round-2"],
  leagueTable: [validLeagueEntry],
  legacyId: 99,
} as const;

describe("SeasonSummarySchema", () => {
  test("round-trips a valid SeasonSummary", () => {
    const summary = { id: "season-2026", year: 2026, active: true };

    expect(SeasonSummarySchema.parse(summary)).toEqual(summary);
  });

  test("coerces legacy string year to an integer", () => {
    const parsed = SeasonSummarySchema.parse({
      id: "season-2026",
      year: "2026",
      active: true,
    });

    expect(parsed.year).toBe(2026);
  });

  test("throws when year identity field is missing", () => {
    const { year: _year, ...withoutYear } = validSeason;

    expect(() => SeasonSummarySchema.parse(withoutYear)).toThrow();
  });

  test("heals unparseable date fields to null", () => {
    const parsed = SeasonSummarySchema.parse({
      id: "season-2026",
      year: 2026,
      active: true,
      start: "not-a-date",
      end: "also-not-a-date",
    });

    expect(parsed.start).toBeNull();
    expect(parsed.end).toBeNull();
  });
});

describe("LeagueEntrySchema", () => {
  test("round-trips a valid LeagueEntry", () => {
    expect(LeagueEntrySchema.parse(validLeagueEntry)).toEqual(validLeagueEntry);
  });
});

describe("SeasonSchema", () => {
  test("round-trips a valid Season", () => {
    expect(SeasonSchema.parse(validSeason)).toEqual(validSeason);
  });

  test("defaults missing rounds and league table to empty arrays", () => {
    const parsed = SeasonSchema.parse({ id: "season-2026", year: 2026, active: false });

    expect(parsed.rounds).toEqual([]);
    expect(parsed.leagueTable).toEqual([]);
  });

  test("heals invalid nested league entries while preserving valid entries", () => {
    const parsed = SeasonSchema.parse({
      id: "season-2026",
      year: 2026,
      active: true,
      rounds: ["round-1", 2, "round-2"],
      leagueTable: [validLeagueEntry, null, "bad-entry"],
    });

    expect(parsed.rounds).toEqual(["round-1", "round-2"]);
    expect(parsed.leagueTable).toEqual([validLeagueEntry]);
  });
});
