import { describe, expect, test } from "vitest";

import { BriefSchema } from "../brief.js";
import {
  FlightSchema,
  PilotSlotSchema,
  RoundSchema,
  RoundStatusSchema,
  RoundSummarySchema,
  TeamSchema,
} from "../round.js";
import { SignToFlyWordingSchema } from "../signToFly.js";

const validFlight = {
  id: "flight-1",
  distance: 42.5,
  duration: 91,
  url: "https://example.test/flight/1",
  dateTime: "2026-06-11T13:00:00.000Z",
  scoringType: "XC",
  score: 43,
  wingFactor: 0.96,
  isManualLog: false,
  isFirstXC: true,
  isFirstUKXC: false,
  isUKPersonalBest: false,
  isOverallPB: false,
  awardedFirstXC: true,
  awardedFirstUKXC: false,
  awardedUKPB: false,
  awardedOverallPB: false,
} as const;

const validPilotSlot = {
  placeInTeam: 1,
  isScoring: true,
  status: "Filled",
  accountedFor: true,
  signToFly: true,
  noScore: false,
  pilotPoints: 43,
  pilotId: "pilot-1",
  snapshot: {
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
  },
  flight: validFlight,
} as const;

const validTeam = {
  id: "team-1",
  teamName: "Avon A",
  club: {
    id: "club-1",
    name: "Avon HGPG Club",
  },
  score: 43,
  pureTrackGroupId: 123,
  pureTrackGroupSlug: "avon-a",
  pilots: [validPilotSlot],
  captainPilotId: "pilot-1",
  createdAt: "2026-06-11T09:00:00.000Z",
  updatedAt: "2026-06-11T10:00:00.000Z",
  updatedBy: "admin-1",
  legacyId: 7,
} as const;

const validRound = {
  id: "round-1",
  legacyId: 99,
  date: "2026-06-11",
  status: "Confirmed",
  isLocked: false,
  maxTeams: 10,
  minimumScore: 5,
  pureTrackGroupId: 456,
  pureTrackGroupName: "BCC Round 1",
  pureTrackGroupSlug: "bcc-round-1",
  site: {
    id: "site-1",
    name: "Llangollen",
    parkingW3W: "filled.count.soap",
    briefingW3W: "scale.paper.trace",
    takeOffW3W: "rental.shape.tests",
  },
  organisingClub: {
    id: "club-1",
    name: "Avon HGPG Club",
  },
  season: {
    year: 2026,
  },
  teams: [validTeam],
  createdAt: "2026-06-11T08:00:00.000Z",
  updatedAt: "2026-06-11T10:00:00.000Z",
  updatedBy: "admin-1",
} as const;

describe("RoundStatusSchema", () => {
  test("heals legacy status values to canonical values", () => {
    expect(RoundStatusSchema.parse("BriefingComplete")).toBe("BriefComplete");
  });
});

describe("RoundSummarySchema", () => {
  test("round-trips a valid RoundSummary", () => {
    const summary = {
      id: "round-1",
      legacyId: 99,
      date: "2026-06-11",
      siteId: "site-1",
      siteName: "Llangollen",
      status: "Confirmed",
      seasonYear: 2026,
    } as const;

    expect(RoundSummarySchema.parse(summary)).toEqual(summary);
  });
});

describe("RoundSchema", () => {
  test("round-trips a valid Round", () => {
    expect(RoundSchema.parse(validRound)).toEqual(validRound);
  });

  test("fails when id identity field is missing", () => {
    const { id: _id, ...withoutId } = validRound;

    expect(RoundSchema.safeParse(withoutId).success).toBe(false);
  });

  test("heals one corrupt team slot without dropping intact teams", () => {
    const parsed = RoundSchema.parse({
      ...validRound,
      teams: [
        { ...validTeam, id: "team-1" },
        { garbage: 1 },
        { ...validTeam, id: "team-2", teamName: "Avon B" },
      ],
    });

    expect(parsed.teams).toHaveLength(2);
    expect(parsed.teams.map((team) => team.id)).toEqual(["team-1", "team-2"]);
  });

  test("fills defaults for missing scalar and nested array fields", () => {
    const parsed = RoundSchema.parse({
      id: "round-minimal",
      site: { id: "site-1", name: "Llangollen" },
      season: {},
    });

    expect(parsed).toEqual({
      id: "round-minimal",
      date: "",
      status: "Proposed",
      isLocked: false,
      maxTeams: 0,
      minimumScore: 0,
      site: { id: "site-1", name: "Llangollen" },
      season: { year: 0 },
      teams: [],
    });
  });

  test("strips unknown Round keys and never preserves wingFactors snapshots", () => {
    const parsed = RoundSchema.parse({
      ...validRound,
      obsolete: true,
      wingFactors: { "EN A": 1 },
      site: { ...validRound.site, obsoleteSite: true },
    });

    expect(parsed).not.toHaveProperty("obsolete");
    expect(parsed).not.toHaveProperty("wingFactors");
    expect(parsed.site).not.toHaveProperty("obsoleteSite");
  });

  test("preserves generated round brief metadata", () => {
    const brief = {
      version: 1,
      jsonPath: "x",
      pdfPath: "y",
      generatedAt: "z",
    } as const;

    expect(RoundSchema.parse({ ...validRound, brief }).brief).toEqual(brief);
  });

  test("fills optional fields with undefined when invalid", () => {
    const parsed = RoundSchema.parse({
      ...validRound,
      organisingClub: { id: "club-1" },
      pureTrackGroupId: "not-a-number",
    });

    expect(parsed.organisingClub).toBeUndefined();
    expect(parsed.pureTrackGroupId).toBeUndefined();
  });
});

describe("TeamSchema and nested arrays", () => {
  test("heals corrupt pilot slots inside a valid team", () => {
    const parsed = TeamSchema.parse({
      ...validTeam,
      pilots: [validPilotSlot, { garbage: 1 }, { ...validPilotSlot, placeInTeam: 2 }],
    });

    expect(parsed.pilots).toHaveLength(2);
    expect(parsed.pilots.map((pilot) => pilot.placeInTeam)).toEqual([1, 2]);
  });
});

describe("PilotSlotSchema and FlightSchema", () => {
  test("fills optional nested flight fields", () => {
    const parsed = PilotSlotSchema.parse({
      placeInTeam: 1,
      status: "filled",
      pilotId: null,
      flight: {
        id: "flight-2",
      },
    });

    expect(parsed).toMatchObject({
      placeInTeam: 1,
      isScoring: false,
      status: "Filled",
      accountedFor: false,
      signToFly: false,
      noScore: false,
      pilotPoints: 0,
      pilotId: null,
      snapshot: null,
      flight: {
        id: "flight-2",
        distance: 0,
        scoringType: "XC",
        score: 0,
        wingFactor: 1,
        isManualLog: false,
      },
    });
  });

  test("hard-fails missing nested flight id", () => {
    const { id: _id, ...withoutId } = validFlight;

    expect(FlightSchema.safeParse(withoutId).success).toBe(false);
  });
});

describe("RoundSchema strips time fields (T2)", () => {
  test("briefingTime is STRIPPED from a parsed Round (not present on output)", () => {
    const parsed = RoundSchema.parse({ ...validRound });
    expect(parsed).not.toHaveProperty("briefingTime");
  });

  test("landByTime is STRIPPED from a parsed Round", () => {
    const parsed = RoundSchema.parse({ ...validRound });
    expect(parsed).not.toHaveProperty("landByTime");
  });

  test("checkInByTime is STRIPPED from a parsed Round", () => {
    const parsed = RoundSchema.parse({ ...validRound });
    expect(parsed).not.toHaveProperty("checkInByTime");
  });

  test("narrative is STRIPPED from a parsed Round", () => {
    const parsed = RoundSchema.parse({ ...validRound });
    expect(parsed).not.toHaveProperty("narrative");
  });
});

describe("BriefSchema retains time fields (T2)", () => {
  const validBrief = {
    roundId: "round-1",
    generatedAt: "2026-06-11T09:00:00Z",
    date: "2026-06-11",
    siteName: "Llangollen",
    briefingTime: "09:30",
    checkInByTime: "19:00",
    landByTime: "18:00",
    teams: [],
  } as const;

  test("BriefSchema retains briefingTime", () => {
    const parsed = BriefSchema.parse(validBrief);
    expect(parsed.briefingTime).toBe("09:30");
  });

  test("BriefSchema retains checkInByTime", () => {
    const parsed = BriefSchema.parse(validBrief);
    expect(parsed.checkInByTime).toBe("19:00");
  });

  test("BriefSchema retains landByTime", () => {
    const parsed = BriefSchema.parse(validBrief);
    expect(parsed.landByTime).toBe("18:00");
  });

  test("BriefSchema accepts top-level hash", () => {
    const parsed = BriefSchema.parse({ ...validBrief, hash: "abc123" });
    expect(parsed.hash).toBe("abc123");
  });
});

describe("SignToFlyWordingSchema markdown-only (T2)", () => {
  const validMarkdownWording = {
    version: 1,
    hash: "wording-hash",
    markdown: "# Sign to fly\n\nPlease read carefully.",
    createdAt: "2026-06-11T00:00:00Z",
    createdBy: "admin-1",
  } as const;

  test("parses a valid markdown-only wording object", () => {
    expect(SignToFlyWordingSchema.parse(validMarkdownWording)).toEqual(validMarkdownWording);
  });

  test("fails when markdown field is missing", () => {
    const { markdown: _markdown, ...withoutMarkdown } = validMarkdownWording;
    expect(SignToFlyWordingSchema.safeParse(withoutMarkdown).success).toBe(false);
  });

  test("fails when only html is provided (no markdown)", () => {
    expect(
      SignToFlyWordingSchema.safeParse({
        version: 1,
        hash: "wording-hash",
        html: "<p>Sign to fly</p>",
        createdAt: "2026-06-11T00:00:00Z",
        createdBy: "admin-1",
      }).success,
    ).toBe(false);
  });
});
