import { describe, expect, test } from "vitest";

import { FrequencySchema, SeasonClubSchema } from "../seasonClub.js";

const validSeasonClub = {
  id: "season-club-2026-club-1",
  seasonYear: 2026,
  clubId: "club-1",
  numTeams: 2,
  acceptedTsCs: true,
  acceptedTsCsAt: "2026-06-11T00:00:00.000Z",
  acceptedTsCsBy: "admin@example.com",
  frequency: {
    id: "freq-a",
    label: "A",
    position: 1,
  },
  createdAt: "2026-06-11T00:00:00.000Z",
  updatedAt: "2026-06-11T00:00:00.000Z",
  updatedBy: "user-1",
} as const;

describe("FrequencySchema", () => {
  test("round-trips a valid Frequency", () => {
    expect(FrequencySchema.parse(validSeasonClub.frequency)).toEqual(validSeasonClub.frequency);
  });

  test("preserves legacyId", () => {
    const frequency = { ...validSeasonClub.frequency, legacyId: 12 };

    expect(FrequencySchema.parse(frequency)).toEqual(frequency);
  });
});

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

  test("preserves current frequency field without id until Wave 7 removes it", () => {
    const parsed = SeasonClubSchema.parse({
      ...validSeasonClub,
      frequency: { label: "A", position: 1 },
    });

    expect(parsed.frequency).toEqual({ id: "", label: "A", position: 1 });
  });

  test("accepts SeasonClub without optional frequency", () => {
    const { frequency: _frequency, ...withoutFrequency } = validSeasonClub;

    expect(SeasonClubSchema.parse(withoutFrequency)).toEqual(withoutFrequency);
  });

  test("strips unknown SeasonClub keys", () => {
    const parsed = SeasonClubSchema.parse({ ...validSeasonClub, obsolete: true });

    expect(parsed).toEqual(validSeasonClub);
    expect(parsed).not.toHaveProperty("obsolete");
  });

  test("preserves optional legacyId", () => {
    const seasonClub = { ...validSeasonClub, legacyId: 42 };

    expect(SeasonClubSchema.parse(seasonClub)).toEqual(seasonClub);
  });
});
