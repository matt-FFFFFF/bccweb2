import type {
  BriefPilotEntry,
  BriefTeamEntry,
  BriefVersion,
  ManufacturerRef,
  PilotSnapshot,
  RoundBrief,
  WingClass,
} from "@bccweb/types";
import * as z from "zod/v4";

import { healed, healingArray, lenientOptional, normalizeEnum } from "./helpers.js";

// Brief image uploads are capped by the API at 10 per brief. The schema enforces
// that storage contract so over-cap blobs fail clearly instead of being silently
// treated as valid brief documents.

const pilotRatingValues = ["Club Pilot", "Pilot", "Advanced Pilot"] as const;
const wingClassValues = [
  "EN A",
  "EN B",
  "EN C",
  "EN C 2-liner",
  "EN D",
  "EN D 2-liner",
] as const;

const pilotRatingAliases = {
  clubPilot: "Club Pilot",
  club_pilot: "Club Pilot",
  ClubPilot: "Club Pilot",
  pilot: "Pilot",
  advancedPilot: "Advanced Pilot",
  advanced_pilot: "Advanced Pilot",
  AdvancedPilot: "Advanced Pilot",
} as const satisfies Record<string, (typeof pilotRatingValues)[number]>;

const wingClassAliases = {
  EN_A: "EN A",
  EN_B: "EN B",
  EN_C: "EN C",
  EN_C_2_LINER: "EN C 2-liner",
  EN_D: "EN D",
  EN_D_2_LINER: "EN D 2-liner",
  ENC2Liner: "EN C 2-liner",
  END2Liner: "EN D 2-liner",
} as const satisfies Record<string, WingClass>;

const PilotRatingSchema = z.preprocess(
  normalizeEnum(pilotRatingValues, pilotRatingAliases),
  z.enum(pilotRatingValues),
);

const WingClassSchema = z.preprocess(
  normalizeEnum(wingClassValues, wingClassAliases),
  z.enum(wingClassValues),
);

const ManufacturerRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    websiteUrl: lenientOptional(z.string()),
  })
  .strip();

ManufacturerRefSchema satisfies z.ZodType<ManufacturerRef>;

const PilotSnapshotSchema = z
  .object({
    wingClass: healed(WingClassSchema, "EN A").default("EN A"),
    pilotRating: healed(PilotRatingSchema, "Pilot").default("Pilot"),
    phoneNumber: lenientOptional(z.string()),
    helmetColour: lenientOptional(z.string()),
    harnessType: lenientOptional(z.string()),
    harnessColour: lenientOptional(z.string()),
    wingManufacturer: lenientOptional(z.string()),
    wingModel: lenientOptional(z.string()),
    wingColours: lenientOptional(z.string()),
    emergencyContactName: lenientOptional(z.string()),
    emergencyPhoneNumber: lenientOptional(z.string()),
    medicalInfo: lenientOptional(z.string()),
  })
  .strip();

PilotSnapshotSchema satisfies z.ZodType<PilotSnapshot>;

export const BriefVersionSchema = z
  .object({
    version: z.number().int(),
    hash: z.string().min(1),
    createdAt: z.string().min(1),
    createdBy: z.string().min(1),
    supersededAt: lenientOptional(z.string()),
    supersededBy: lenientOptional(z.number().int()),
  })
  .strip();

BriefVersionSchema satisfies z.ZodType<BriefVersion>;

export const BriefPilotEntrySchema = z
  .object({
    placeInTeam: z.number().int(),
    pilotId: z.string().min(1),
    name: z.string().min(1),
    bhpaNumber: lenientOptional(z.number()),
    pureTrackId: lenientOptional(z.number()),
    wingManufacturer: lenientOptional(ManufacturerRefSchema),
    isScoring: healed(z.boolean(), false).default(false),
    snapshot: PilotSnapshotSchema,
  })
  .strip();

BriefPilotEntrySchema satisfies z.ZodType<BriefPilotEntry>;

export const BriefTeamEntrySchema = z
  .object({
    teamName: z.string().min(1),
    clubName: z.string().min(1),
    pureTrackGroupId: lenientOptional(z.number()),
    pureTrackGroupSlug: lenientOptional(z.string()),
    pilots: healingArray(BriefPilotEntrySchema).default([]),
  })
  .strip();

BriefTeamEntrySchema satisfies z.ZodType<BriefTeamEntry>;

export const BriefSchema = z
  .object({
    roundId: z.string().min(1),
    generatedAt: z.string().min(1),
    date: z.string().min(1),
    siteName: z.string().min(1),
    hash: lenientOptional(z.string()),
    guideUrl: lenientOptional(z.string()),
    parkingW3W: lenientOptional(z.string()),
    briefingW3W: lenientOptional(z.string()),
    takeOffW3W: lenientOptional(z.string()),
    briefingTime: lenientOptional(z.string()),
    checkInByTime: lenientOptional(z.string()),
    landByTime: lenientOptional(z.string()),
    organisingClubName: lenientOptional(z.string()),
    pureTrackGroupName: lenientOptional(z.string()),
    pureTrackGroupSlug: lenientOptional(z.string()),
    windSpeedDirection: lenientOptional(z.string()),
    directionOfFlight: lenientOptional(z.string()),
    expectedLandingArea: lenientOptional(z.string()),
    airspaceAndHazards: lenientOptional(z.string()),
    NOTAMs: lenientOptional(z.string()),
    BENO_LineDescription: lenientOptional(z.string()),
    briefersNotes: lenientOptional(z.string()),
    frequencyMhz: lenientOptional(z.number().positive().lt(1000)),
    briefer: lenientOptional(
      z
        .object({
          name: lenientOptional(z.string()),
          bhpaCoachLevel: lenientOptional(z.string()),
          bhpaNumber: lenientOptional(z.string()),
          phoneNumber: lenientOptional(z.string()),
          emailAddress: lenientOptional(z.string()),
        })
        .strip(),
    ),
    imagePaths: z.array(z.string()).max(10, "RoundBrief imagePaths must contain at most 10 paths").optional(),
    version: lenientOptional(z.number().int()),
    versionHistory: lenientOptional(healingArray(BriefVersionSchema)),
    teams: healingArray(BriefTeamEntrySchema).default([]),
  })
  .strip();

BriefSchema satisfies z.ZodType<RoundBrief>;

// Coordinator-editable subset for PUT /rounds/{id}/brief. Excludes identity
// (roundId/generatedAt/date/siteName) + derived state (teams/hash/
// versionHistory/imagePaths) so a partial edit body validates WITHOUT them;
// the full BriefSchema validates the merged result on write.
export const BriefEditableSchema = BriefSchema.partial().pick({
  briefingTime: true,
  checkInByTime: true,
  landByTime: true,
  parkingW3W: true,
  briefingW3W: true,
  takeOffW3W: true,
  windSpeedDirection: true,
  directionOfFlight: true,
  expectedLandingArea: true,
  airspaceAndHazards: true,
  NOTAMs: true,
  BENO_LineDescription: true,
  briefersNotes: true,
  frequencyMhz: true,
  briefer: true,
});

export const BRIEF_EDITABLE_KEYS = Object.keys(
  BriefEditableSchema.shape,
) as Array<keyof typeof BriefEditableSchema.shape>;
