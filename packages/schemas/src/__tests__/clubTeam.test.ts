import { describe, expect, test } from "vitest";

import { ClubTeamSchema, ClubTeamSummarySchema } from "../clubTeam.js";

const validClubTeam = {
  id: "ct1",
  clubId: "club1",
  clubName: "Avon HGPG Club",
  seasonYear: 2026,
  teamName: "Avon A",
  createdAt: "2026-06-11T00:00:00.000Z",
} as const;

describe("ClubTeamSchema", () => {
  test("round-trips a valid ClubTeam", () => {
    expect(ClubTeamSchema.parse(validClubTeam)).toEqual(validClubTeam);
  });

  test("fails when id identity field is missing", () => {
    const { id: _id, ...withoutId } = validClubTeam;

    expect(ClubTeamSchema.safeParse(withoutId).success).toBe(false);
  });

  test("fails when clubId identity field is missing", () => {
    const result = ClubTeamSchema.safeParse({ id: "ct1" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "clubId")).toBe(true);
    }
  });

  test("strips unknown ClubTeam keys", () => {
    const parsed = ClubTeamSchema.parse({ ...validClubTeam, obsolete: true });

    expect(parsed).toEqual(validClubTeam);
    expect(parsed).not.toHaveProperty("obsolete");
  });

  test("preserves optional legacyId", () => {
    const clubTeam = { ...validClubTeam, legacyId: 42 };

    expect(ClubTeamSchema.parse(clubTeam)).toEqual(clubTeam);
  });
});

describe("ClubTeamSummarySchema", () => {
  test("round-trips a valid ClubTeamSummary", () => {
    const { createdAt: _createdAt, ...summary } = validClubTeam;

    expect(ClubTeamSummarySchema.parse(summary)).toEqual(summary);
  });
});
