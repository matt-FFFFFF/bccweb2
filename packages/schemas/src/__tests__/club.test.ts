import { describe, expect, test } from "vitest";

import { ClubSchema, ClubSummarySchema } from "../club.js";

const validClub = {
  id: "club-1",
  name: "North Club",
  legacyId: 101,
  sites: ["site-1", "site-2"],
  teams: ["legacy-team-1"],
  createdAt: "2026-06-11T00:00:00.000Z",
  updatedAt: "2026-06-11T00:01:00.000Z",
  updatedBy: "user-1",
} as const;

describe("ClubSummarySchema", () => {
  test("round-trips a valid ClubSummary", () => {
    expect(ClubSummarySchema.parse({ id: "club-1", name: "North Club" })).toEqual({
      id: "club-1",
      name: "North Club",
    });
  });
});

describe("ClubSchema", () => {
  test("round-trips a valid Club", () => {
    expect(ClubSchema.parse(validClub)).toEqual(validClub);
  });

  test("fails when id identity field is missing", () => {
    const { id: _id, ...withoutId } = validClub;

    expect(ClubSchema.safeParse(withoutId).success).toBe(false);
  });

  test("fails when name identity field is missing", () => {
    const { name: _name, ...withoutName } = validClub;

    expect(ClubSchema.safeParse(withoutName).success).toBe(false);
  });

  test("strips unknown Club keys", () => {
    const parsed = ClubSchema.parse({ ...validClub, junk: 1 });

    expect(parsed).not.toHaveProperty("junk");
  });

  test("defaults missing sites to an empty array", () => {
    const parsed = ClubSchema.parse({ id: "club-1", name: "North Club" });

    expect(parsed.sites).toEqual([]);
  });

  test("heals invalid optional and array fields", () => {
    const parsed = ClubSchema.parse({
      id: "club-1",
      name: "North Club",
      legacyId: "101",
      sites: ["site-1", 2, null, "site-2"],
      teams: ["team-1", false, "team-2"],
      createdAt: 1,
      updatedAt: "2026-06-11T00:01:00.000Z",
    });

    expect(parsed).toEqual({
      id: "club-1",
      name: "North Club",
      sites: ["site-1", "site-2"],
      teams: ["team-1", "team-2"],
      updatedAt: "2026-06-11T00:01:00.000Z",
    });
  });
});
