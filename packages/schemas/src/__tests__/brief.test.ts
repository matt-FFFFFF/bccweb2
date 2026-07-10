// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";

import {
  BRIEF_EDITABLE_KEYS,
  BriefEditableSchema,
  BriefPilotEntrySchema,
  BriefSchema,
  BriefTeamEntrySchema,
  BriefVersionSchema,
  MATERIAL_BRIEF_FIELDS,
} from "../brief.js";

const validSnapshot = {
  wingClass: "EN C",
  pilotRating: "Pilot",
  phoneNumber: "07700 900000",
  helmetColour: "White",
  harnessType: "Pod",
  harnessColour: "Black",
  wingManufacturer: "Ozone",
  wingModel: "Delta",
  wingColours: "Blue and white",
  emergencyContactName: "Emergency Contact",
  emergencyPhoneNumber: "07700 900001",
  medicalInfo: "Asthma inhaler in harness",
} as const;

const validPilot = {
  placeInTeam: 1,
  pilotId: "pilot-1",
  name: "Ada Pilot",
  bhpaNumber: 999,
  pureTrackId: 42,
  wingManufacturer: {
    id: "manufacturer-1",
    name: "Ozone",
    websiteUrl: "https://example.test/ozone",
  },
  isScoring: true,
  snapshot: validSnapshot,
} as const;

const validTeam = {
  teamName: "Avon A",
  clubName: "Avon HGPG Club",
  pureTrackGroupId: 123,
  pureTrackGroupSlug: "avon-a",
  pilots: [validPilot],
} as const;

const validVersion = {
  version: 2,
  hash: "sha256:abc123",
  createdAt: "2026-06-11T09:00:00.000Z",
  createdBy: "admin-1",
  supersededAt: "2026-06-11T10:00:00.000Z",
  supersededBy: 3,
} as const;

const validBrief = {
  roundId: "round-1",
  generatedAt: "2026-06-11T08:00:00.000Z",
  date: "2026-06-11",
  siteName: "Llangollen",
  guideUrl: "https://example.test/site-guide",
  parkingW3W: "filled.count.soap",
  briefingW3W: "scale.paper.trace",
  takeOffW3W: "rental.shape.tests",
  briefingTime: "09:30",
  checkInByTime: "19:00",
  landByTime: "18:00",
  organisingClubName: "Avon HGPG Club",
  pureTrackGroupName: "BCC Round 1",
  pureTrackGroupSlug: "bcc-round-1",
  windSpeedDirection: "SW 10-15",
  directionOfFlight: "North along ridge",
  expectedLandingArea: "Main bottom landing field",
  airspaceAndHazards: "Avoid controlled airspace to the east",
  NOTAMs: "None active",
  BENO_LineDescription: "BENO line follows the ridge",
  briefersNotes: "Keep clear of livestock",
  briefer: {
    name: "Briefing Coach",
    bhpaCoachLevel: "SeniorCoach",
    bhpaNumber: "12345",
    phoneNumber: "07700 900002",
    emailAddress: "briefer@example.test",
  },
  imagePaths: ["round-briefs/round-1/image-1.jpg"],
  version: 2,
  versionHistory: [validVersion],
  teams: [validTeam],
} as const;

describe("BriefVersionSchema", () => {
  test("round-trips a valid BriefVersion", () => {
    expect(BriefVersionSchema.parse(validVersion)).toEqual(validVersion);
  });

  test("fails when version identity field is missing", () => {
    const { version: _version, ...withoutVersion } = validVersion;

    expect(BriefVersionSchema.safeParse(withoutVersion).success).toBe(false);
  });
});

describe("BriefPilotEntrySchema", () => {
  test("preserves permitted pilot PII fields", () => {
    const parsed = BriefPilotEntrySchema.parse(validPilot);

    expect(parsed.bhpaNumber).toBe(999);
    expect(parsed.pureTrackId).toBe(42);
  });

  test("heals invalid snapshot enums to defaults (no aliases) and default scoring flag", () => {
    const { isScoring: _isScoring, ...withoutScoring } = validPilot;
    const parsed = BriefPilotEntrySchema.parse({
      ...withoutScoring,
      snapshot: {
        ...validSnapshot,
        wingClass: "EN_C_2_LINER",
        pilotRating: "advanced_pilot",
      },
    });

    expect(parsed.isScoring).toBe(false);
    expect(parsed.snapshot.wingClass).toBe("EN A");
    expect(parsed.snapshot.pilotRating).toBe("Pilot");
  });
});

describe("BriefTeamEntrySchema", () => {
  test("heals corrupt pilot entries without dropping valid pilots", () => {
    const parsed = BriefTeamEntrySchema.parse({
      ...validTeam,
      pilots: [validPilot, { garbage: true }, { ...validPilot, placeInTeam: 2 }],
    });

    expect(parsed.pilots).toHaveLength(2);
    expect(parsed.pilots.map((pilot) => pilot.placeInTeam)).toEqual([1, 2]);
  });
});

describe("BriefSchema", () => {
  test("round-trips a valid RoundBrief", () => {
    expect(BriefSchema.parse(validBrief)).toEqual(validBrief);
  });

  test("preserves permitted briefer contact PII", () => {
    const parsed = BriefSchema.parse(validBrief);

    expect(parsed.briefer?.phoneNumber).toBe("07700 900002");
    expect(parsed.briefer?.emailAddress).toBe("briefer@example.test");
    expect(parsed.briefer?.bhpaNumber).toBe("12345");
  });

  test("rejects imagePaths arrays over the documented cap", () => {
    const result = BriefSchema.safeParse({
      ...validBrief,
      imagePaths: Array.from({ length: 11 }, (_, index) => `round-briefs/round-1/image-${index + 1}.jpg`),
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("at most 10");
  });

  test("strips unknown keys and does not preserve future fields", () => {
    const parsed = BriefSchema.parse({
      ...validBrief,
      extra: true,
    });

    expect(parsed).not.toHaveProperty("extra");
  });

  test("fills missing optional arrays and scalar defaults", () => {
    expect(
      BriefSchema.parse({
        roundId: "round-minimal",
        generatedAt: "2026-06-11T08:00:00.000Z",
        date: "2026-06-11",
        siteName: "Llangollen",
      }),
    ).toEqual({
      roundId: "round-minimal",
      generatedAt: "2026-06-11T08:00:00.000Z",
      date: "2026-06-11",
      siteName: "Llangollen",
      teams: [],
    });
  });
});

describe("BriefEditableSchema (coordinator-editable subset)", () => {
  test("validates a partial edit body without identity/derived fields", () => {
    const result = BriefEditableSchema.safeParse({
      NOTAMs: "Temporary restricted area active",
      frequencyMhz: 143.925,
      briefer: { name: "Alice" },
    });

    expect(result.success).toBe(true);
  });

  test("strips identity, derived, and image-only keys from an edit body", () => {
    const parsed = BriefEditableSchema.parse({
      NOTAMs: "None",
      siteName: "identity - not editable",
      teams: [],
      imagePaths: ["round-briefs/x.jpg"],
    });

    expect(parsed.NOTAMs).toBe("None");
    expect(parsed).not.toHaveProperty("siteName");
    expect(parsed).not.toHaveProperty("teams");
    expect(parsed).not.toHaveProperty("imagePaths");
  });

  test("BRIEF_EDITABLE_KEYS = MATERIAL_BRIEF_FIELDS minus imagePaths plus briefer (single-source lock)", () => {
    const derived = [
      ...MATERIAL_BRIEF_FIELDS.filter((field) => field !== "imagePaths"),
      "briefer",
    ];

    expect([...BRIEF_EDITABLE_KEYS].sort()).toEqual([...derived].sort());
    expect([...BRIEF_EDITABLE_KEYS]).not.toContain("imagePaths");
    expect([...BRIEF_EDITABLE_KEYS]).toContain("briefer");
    expect([...MATERIAL_BRIEF_FIELDS]).not.toContain("briefer");
    expect(Object.keys(BriefEditableSchema.shape).sort()).toEqual(
      [...BRIEF_EDITABLE_KEYS].sort(),
    );
  });
});
