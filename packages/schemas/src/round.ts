// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type {
  ClubRef,
  Flight,
  PilotSlot,
  PilotSlotStatus,
  PilotSnapshot,
  Round,
  RoundScoringSnapshot,
  RoundStatus,
  RoundSummary,
  ScoringType,
  SiteRef,
  Team,
} from "@bccweb/types";
import {
  PILOT_RATINGS,
  PILOT_SLOT_STATUSES,
  ROUND_STATUSES,
  SCORING_TYPES,
  WING_CLASSES,
} from "@bccweb/types";
import * as z from "zod/v4";

import { healed, healingArray, lenientOptional } from "./helpers.js";

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

export const RoundStatusSchema = z.enum(ROUND_STATUSES).catch("Proposed");

export const PilotSlotStatusSchema = z.enum(PILOT_SLOT_STATUSES).catch("Empty");

export const ScoringTypeSchema = z.enum(SCORING_TYPES).catch("XC");

const PilotRatingSchema = z.enum(PILOT_RATINGS);

const WingClassSchema = z.enum(WING_CLASSES);

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
    igcPath: lenientOptional(z.string()),
    sanityFlags: lenientOptional(z.array(z.string())),
    scoredAt: lenientOptional(z.string()),
    scoredByVersion: lenientOptional(z.string()),
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

const RoundScoringPilotFactorsSchema = z
  .object({
    "Club Pilot": z.number(),
    Pilot: z.number(),
    "Advanced Pilot": z.number(),
  })
  .strict();

const RoundScoringWingFactorsSchema = z
  .object({
    "EN A": z.number(),
    "EN B": z.number(),
    "EN C": z.number(),
    "EN C 2-liner": z.number(),
    "EN D": z.number(),
    "EN D 2-liner": z.number(),
  })
  .strict();

// Audit snapshot: validated STRICTLY with no per-field healing/defaults so a
// stored snapshot is preserved verbatim or (via the outer `lenientOptional` on
// `RoundSchema.scoring`) healed to ABSENT as a whole — never silently
// half-fabricated, which would corrupt the re-derivation audit trail.
export const RoundScoringSnapshotSchema = z
  .object({
    taskMaxPoints: z.number(),
    clubsAttendingCount: z.number(),
    clubsAttendingFactor: z.number(),
    minDistanceFlightCount: z.number(),
    minDistanceFactor: z.number(),
    maxPointsForRound: z.number(),
    maxPilotScoreInRound: z.number(),
    maxTeamScore: z.number(),
    maxPilotScoresCountedPerTeam: z.number(),
    leagueRoundScoresCounted: z.number(),
    pilotFactors: RoundScoringPilotFactorsSchema,
    wingFactors: RoundScoringWingFactorsSchema,
    teams: z.array(
      z
        .object({
          teamId: z.string(),
          workingTeamScore: z.number(),
        })
        .strip(),
    ),
    scoredAt: z.string(),
  })
  .strip();

RoundScoringSnapshotSchema satisfies z.ZodType<RoundScoringSnapshot>;

export const RoundSchema = z
  .object({
    id: z.string().min(1),
    legacyId: lenientOptional(z.number().int()),
    date: healed(z.string(), "").default(""),
    status: RoundStatusSchema.default("Proposed"),
    isLocked: healed(z.boolean(), false).default(false),
    maxTeams: healed(z.number().int(), 0).default(0),
    minimumScore: healed(z.number(), 0).default(0),
    pureTrackGroupId: lenientOptional(z.number()),
    pureTrackGroupName: lenientOptional(z.string()),
    pureTrackGroupSlug: lenientOptional(z.string()),
    site: SiteRefSchema,
    organisingClub: lenientOptional(ClubRefSchema),
    season: SeasonRefSchema,
    teams: healingArray(TeamSchema).default([]),
    brief: lenientOptional(
      z
        .object({
          version: lenientOptional(z.number().int()),
          jsonPath: lenientOptional(z.string()),
          pdfPath: lenientOptional(z.string()),
          generatedAt: lenientOptional(z.string()),
          pdfStatus: lenientOptional(z.enum(["pending", "processing", "ready", "failed"])),
          pdfError: lenientOptional(z.string()),
          pdfUpdatedAt: lenientOptional(z.string()),
          pdfAttemptId: lenientOptional(z.string()),
        })
        .strict(),
    ),
    pureTrack: lenientOptional(
      z
        .object({
          status: lenientOptional(z.enum(["pending", "processing", "ready", "failed"])),
          attemptId: lenientOptional(z.string()),
          ownerToken: lenientOptional(z.string()),
          error: lenientOptional(z.string()),
          updatedAt: lenientOptional(z.string()),
        })
        .strip(),
    ),
    scoring: lenientOptional(RoundScoringSnapshotSchema),
    createdAt: lenientOptional(z.string()),
    updatedAt: lenientOptional(z.string()),
    updatedBy: lenientOptional(z.string()),
  })
  .strip();

RoundSchema satisfies z.ZodType<Round>;

ClubRefSchema satisfies z.ZodType<ClubRef>;
SiteRefSchema satisfies z.ZodType<SiteRef>;
