import type {
  ClubRef,
  Flight,
  PilotRatingValue,
  PilotSlot,
  PilotSlotStatus,
  PilotSnapshot,
  Round,
  RoundStatus,
  RoundSummary,
  ScoringType,
  SiteRef,
  Team,
  WingClass,
} from "@bccweb/types";
import * as z from "zod/v4";

import { healed, healingArray, lenientOptional, normalizeEnum } from "./helpers.js";

const roundStatusValues = [
  "Proposed",
  "Confirmed",
  "BriefComplete",
  "Locked",
  "Complete",
  "Cancelled",
] as const;

const pilotSlotStatusValues = ["Empty", "Filled"] as const;
const scoringTypeValues = ["XC", "Manual"] as const;
const pilotRatingValues = ["Club Pilot", "Pilot", "Advanced Pilot"] as const;
const wingClassValues = [
  "EN A",
  "EN B",
  "EN C",
  "EN C 2-liner",
  "EN D",
  "EN D 2-liner",
] as const;

const roundStatusAliases = {
  Draft: "Proposed",
  draft: "Proposed",
  proposed: "Proposed",
  Active: "Confirmed",
  active: "Confirmed",
  confirmed: "Confirmed",
  BriefingComplete: "BriefComplete",
  briefingComplete: "BriefComplete",
  briefing_complete: "BriefComplete",
  brief_complete: "BriefComplete",
  locked: "Locked",
  completed: "Complete",
  complete: "Complete",
  cancelled: "Cancelled",
  canceled: "Cancelled",
} as const satisfies Record<string, RoundStatus>;

const pilotSlotStatusAliases = {
  empty: "Empty",
  vacant: "Empty",
  filled: "Filled",
  assigned: "Filled",
} as const satisfies Record<string, PilotSlotStatus>;

const scoringTypeAliases = {
  xc: "XC",
  Xc: "XC",
  puretrack: "XC",
  PureTrack: "XC",
  manual: "Manual",
} as const satisfies Record<string, ScoringType>;

const pilotRatingAliases = {
  clubPilot: "Club Pilot",
  club_pilot: "Club Pilot",
  ClubPilot: "Club Pilot",
  pilot: "Pilot",
  advancedPilot: "Advanced Pilot",
  advanced_pilot: "Advanced Pilot",
  AdvancedPilot: "Advanced Pilot",
} as const satisfies Record<string, PilotRatingValue>;

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

const ClubRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strip();

const SiteRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    parkingW3W: lenientOptional(z.string()),
    briefingW3W: lenientOptional(z.string()),
    takeOffW3W: lenientOptional(z.string()),
  })
  .strip();

const SeasonRefSchema = z
  .object({
    year: healed(z.number().int(), 0).default(0),
  })
  .strip();

export const RoundStatusSchema = z.preprocess(
  normalizeEnum(roundStatusValues, roundStatusAliases),
  z.enum(roundStatusValues).catch("Proposed"),
);

export const PilotSlotStatusSchema = z.preprocess(
  normalizeEnum(pilotSlotStatusValues, pilotSlotStatusAliases),
  z.enum(pilotSlotStatusValues).catch("Empty"),
);

export const ScoringTypeSchema = z.preprocess(
  normalizeEnum(scoringTypeValues, scoringTypeAliases),
  z.enum(scoringTypeValues).catch("XC"),
);

const PilotRatingSchema = z.preprocess(
  normalizeEnum(pilotRatingValues, pilotRatingAliases),
  z.enum(pilotRatingValues),
);

const WingClassSchema = z.preprocess(
  normalizeEnum(wingClassValues, wingClassAliases),
  z.enum(wingClassValues),
);

RoundStatusSchema satisfies z.ZodType<RoundStatus>;
PilotSlotStatusSchema satisfies z.ZodType<PilotSlotStatus>;
ScoringTypeSchema satisfies z.ZodType<ScoringType>;

export const RoundSummarySchema = z
  .object({
    id: z.string().min(1),
    legacyId: lenientOptional(z.number().int()),
    date: healed(z.string(), "").default(""),
    siteId: healed(z.string(), "").default(""),
    siteName: healed(z.string(), "").default(""),
    status: RoundStatusSchema.default("Proposed"),
    seasonYear: healed(z.number().int(), 0).default(0),
  })
  .strip();

RoundSummarySchema satisfies z.ZodType<RoundSummary>;

export const PilotSnapshotSchema = z
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

export const FlightSchema = z
  .object({
    id: z.string().min(1),
    distance: healed(z.number(), 0).default(0),
    duration: lenientOptional(z.number()),
    url: lenientOptional(z.string()),
    dateTime: lenientOptional(z.string()),
    scoringType: ScoringTypeSchema.default("XC"),
    score: healed(z.number(), 0).default(0),
    wingFactor: healed(z.number(), 1).default(1),
    isManualLog: healed(z.boolean(), false).default(false),
    manualLogJustification: lenientOptional(z.string()),
    isFirstXC: lenientOptional(z.boolean()),
    isFirstUKXC: lenientOptional(z.boolean()),
    isUKPersonalBest: lenientOptional(z.boolean()),
    isOverallPB: lenientOptional(z.boolean()),
    awardedFirstXC: lenientOptional(z.boolean()),
    awardedFirstUKXC: lenientOptional(z.boolean()),
    awardedUKPB: lenientOptional(z.boolean()),
    awardedOverallPB: lenientOptional(z.boolean()),
  })
  .strip();

FlightSchema satisfies z.ZodType<Flight>;

export const PilotSlotSchema = z
  .object({
    placeInTeam: z.number().int(),
    isScoring: healed(z.boolean(), false).default(false),
    status: PilotSlotStatusSchema.default("Empty"),
    accountedFor: healed(z.boolean(), false).default(false),
    signToFly: healed(z.boolean(), false).default(false),
    noScore: healed(z.boolean(), false).default(false),
    pilotPoints: healed(z.number(), 0).default(0),
    pilotId: healed(z.string().nullable(), null).default(null),
    snapshot: healed(PilotSnapshotSchema.nullable(), null).default(null),
    flight: healed(FlightSchema.nullable(), null).default(null),
  })
  .strip();

PilotSlotSchema satisfies z.ZodType<PilotSlot>;

export const TeamSchema = z
  .object({
    id: z.string().min(1),
    teamName: z.string().min(1),
    club: ClubRefSchema,
    score: healed(z.number(), 0).default(0),
    pureTrackGroupId: lenientOptional(z.number()),
    pureTrackGroupSlug: lenientOptional(z.string()),
    pilots: healingArray(PilotSlotSchema).default([]),
    captainPilotId: lenientOptional(z.string().nullable()),
    createdAt: lenientOptional(z.string()),
    updatedAt: lenientOptional(z.string()),
    updatedBy: lenientOptional(z.string()),
    legacyId: lenientOptional(z.number().int()),
  })
  .strip();

TeamSchema satisfies z.ZodType<Team>;

export const RoundSchema = z
  .object({
    id: z.string().min(1),
    legacyId: lenientOptional(z.number().int()),
    date: healed(z.string(), "").default(""),
    status: RoundStatusSchema.default("Proposed"),
    isLocked: healed(z.boolean(), false).default(false),
    maxTeams: healed(z.number().int(), 0).default(0),
    minimumScore: healed(z.number(), 0).default(0),
    briefingTime: lenientOptional(z.string()),
    landByTime: lenientOptional(z.string()),
    checkInByTime: lenientOptional(z.string()),
    narrative: lenientOptional(z.string()),
    pureTrackGroupId: lenientOptional(z.number()),
    pureTrackGroupName: lenientOptional(z.string()),
    pureTrackGroupSlug: lenientOptional(z.string()),
    site: SiteRefSchema,
    organisingClub: lenientOptional(ClubRefSchema),
    season: SeasonRefSchema,
    teams: healingArray(TeamSchema).default([]),
    createdAt: lenientOptional(z.string()),
    updatedAt: lenientOptional(z.string()),
    updatedBy: lenientOptional(z.string()),
  })
  .strip();

RoundSchema satisfies z.ZodType<Round>;

ClubRefSchema satisfies z.ZodType<ClubRef>;
SiteRefSchema satisfies z.ZodType<SiteRef>;
