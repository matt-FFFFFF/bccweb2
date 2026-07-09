// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";

import { SeasonClubSchema } from "../seasonClub.js";

const validSeasonClub = {
  id: "season-club-2026-club-1",
  seasonYear: 2026,
  clubId: "club-1",
  numTeams: 2,
  acceptedTsCs: true,
  acceptedTsCsAt: "2026-06-11T00:00:00.000Z",
  acceptedTsCsBy: "admin@example.com",
  createdAt: "2026-06-11T00:00:00.000Z",
  updatedAt: "2026-06-11T00:00:00.000Z",
  updatedBy: "user-1",
} as const;

describe("SeasonClubSchema", () => {
  test("round-trips a valid SeasonClub", () => {
    expect(SeasonClubSchema.parse(validSeasonClub)).toEqual(validSeasonClub);
  });

  test("fails when id identity field is missing", () => {
    const { id: _id, ...withoutId } = validSeasonClub;

    expect(SeasonClubSchema.safeParse(withoutId).success).toBe(false);
  });

  test("fails when composite identity field clubId is missing", () => {
    const { clubId: _clubId, ...withoutClubId } = validSeasonClub;
    const result = SeasonClubSchema.safeParse(withoutClubId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "clubId")).toBe(true);
    }
  });

  test("strips unknown SeasonClub keys (including legacy frequency)", () => {
    const parsed = SeasonClubSchema.parse({
      ...validSeasonClub,
      obsolete: true,
      frequency: { id: "freq-a", label: "A", position: 1 },
    });

    expect(parsed).toEqual(validSeasonClub);
    expect(parsed).not.toHaveProperty("obsolete");
    expect(parsed).not.toHaveProperty("frequency");
  });

  test("preserves optional legacyId", () => {
    const seasonClub = { ...validSeasonClub, legacyId: 42 };

    expect(SeasonClubSchema.parse(seasonClub)).toEqual(seasonClub);
  });
});
