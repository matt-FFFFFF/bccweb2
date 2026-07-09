// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";

import { PureTrackGroupSchema } from "../puretrack.js";

const validPureTrackGroup = {
  groupId: "puretrack-group-1",
  name: "BCC Sat 20 Jun Avon A",
  slug: "bcc-sat-20-jun-avon-a",
  pilotIds: ["pilot-1", "pilot-2"],
  roundId: "round-1",
  teamId: "team-1",
  createdAt: "2026-06-11T10:00:00.000Z",
  createdBy: "user-1",
  externalId: "12345",
  externalUrl: "https://puretrack.io/group/bcc-sat-20-jun-avon-a",
} as const;

describe("PureTrackGroupSchema", () => {
  test("parses the stored PureTrack group blob into PureTrackGroup", () => {
    expect(PureTrackGroupSchema.parse(validPureTrackGroup)).toEqual({
      id: validPureTrackGroup.groupId,
      name: validPureTrackGroup.name,
      slug: validPureTrackGroup.slug,
      pilotIds: validPureTrackGroup.pilotIds,
      roundId: validPureTrackGroup.roundId,
      teamId: validPureTrackGroup.teamId,
      createdAt: validPureTrackGroup.createdAt,
      createdBy: validPureTrackGroup.createdBy,
      externalId: validPureTrackGroup.externalId,
      externalUrl: validPureTrackGroup.externalUrl,
    });
  });

  test.each(["groupId", "slug", "roundId", "teamId"] as const)(
    "fails when %s identity field is missing",
    (field) => {
      const { [field]: _omitted, ...withoutField } = validPureTrackGroup;
      const result = PureTrackGroupSchema.safeParse(withoutField);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
      }
    },
  );

  test("heals scalar and array payload fields while preserving identity", () => {
    const parsed = PureTrackGroupSchema.parse({
      groupId: "puretrack-group-2",
      slug: "puretrack-group-2",
      roundId: "round-2",
      teamId: "team-2",
      pilotIds: ["pilot-3", { corrupt: true }, "pilot-4"],
      name: 123,
      createdAt: null,
    });

    expect(parsed).toEqual({
      id: "puretrack-group-2",
      slug: "puretrack-group-2",
      roundId: "round-2",
      teamId: "team-2",
      pilotIds: ["pilot-3", "pilot-4"],
      name: "",
      createdAt: "",
    });
  });

  test("strips unknown stored blob fields", () => {
    const parsed = PureTrackGroupSchema.parse({
      ...validPureTrackGroup,
      obsolete: true,
    });

    expect(parsed).not.toHaveProperty("obsolete");
  });
});
