import type { Pilot, PilotSummary } from "@bccweb/types";
import * as z from "zod/v4";

import { healed, healingArray, lenientOptional, normalizeEnum } from "./helpers.js";

const coachTypeValues = [
  "None",
  "ClubCoach",
  "SeniorCoach",
  "Instructor",
  "SeniorInstructor",
] as const;

const pilotRatingValues = ["Club Pilot", "Pilot", "Advanced Pilot"] as const;

const wingClassValues = [
  "EN A",
  "EN B",
  "EN C",
  "EN C 2-liner",
  "EN D",
  "EN D 2-liner",
] as const;

const coachTypeAliases = {
  none: "None",
  clubCoach: "ClubCoach",
  club_coach: "ClubCoach",
  seniorCoach: "SeniorCoach",
  senior_coach: "SeniorCoach",
  instructor: "Instructor",
  seniorInstructor: "SeniorInstructor",
  senior_instructor: "SeniorInstructor",
} as const satisfies Record<string, (typeof coachTypeValues)[number]>;

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
} as const satisfies Record<string, (typeof wingClassValues)[number]>;

const HealedLegacyIdSchema = healed(z.number().nullable(), null).default(null);
const NullableStringSchema = z.string().nullable();

const ClubRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strip();

const ManufacturerRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    websiteUrl: lenientOptional(z.string()),
  })
  .strip();

const PersonSchema = z
  .object({
    id: z.string().min(1),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    fullName: z.string().min(1),
    phoneNumber: lenientOptional(z.string()),
  })
  .strip();

const PilotSeasonClubSchema = z
  .object({
    seasonYear: healed(z.number().int(), 0),
    clubId: z.string().min(1),
    clubName: z.string().min(1),
  })
  .strip();

const CoachTypeSchema = z.preprocess(
  normalizeEnum(coachTypeValues, coachTypeAliases),
  z.enum(coachTypeValues),
);

const PilotRatingSchema = z.preprocess(
  normalizeEnum(pilotRatingValues, pilotRatingAliases),
  z.enum(pilotRatingValues),
);

const WingClassSchema = z.preprocess(
  normalizeEnum(wingClassValues, wingClassAliases),
  z.enum(wingClassValues),
);

export const PilotSummarySchema = z
  .object({
    id: z.string().min(1),
    legacyId: HealedLegacyIdSchema,
    name: z.string().min(1),
    clubId: lenientOptional(z.string()),
    rating: lenientOptional(PilotRatingSchema),
  })
  .strip();

PilotSummarySchema satisfies z.ZodType<
  Omit<PilotSummary, "legacyId"> & { legacyId: number | null }
>;

export const PilotSchema = z
  .object({
    id: z.string().min(1),
    legacyId: HealedLegacyIdSchema,
    bhpaNumber: lenientOptional(z.number()),
    coachType: healed(CoachTypeSchema, "None").default("None"),
    pilotRating: healed(PilotRatingSchema, "Pilot").default("Pilot"),
    pureTrackId: lenientOptional(z.number()),
    pureTrackLink: lenientOptional(z.string()),
    helmetColour: lenientOptional(z.string()),
    harnessType: lenientOptional(z.string()),
    harnessColour: lenientOptional(z.string()),
    emergencyContactName: lenientOptional(z.string()),
    emergencyPhoneNumber: lenientOptional(z.string()),
    medicalInfo: lenientOptional(z.string()),
    wingClass: lenientOptional(WingClassSchema),
    wingManufacturer: lenientOptional(ManufacturerRefSchema),
    wingModel: lenientOptional(z.string()),
    wingColours: lenientOptional(z.string()),
    person: PersonSchema,
    currentClub: lenientOptional(ClubRefSchema),
    profileUpdatedAt: lenientOptional(z.string()),
    seasonClubs: healingArray(PilotSeasonClubSchema).default([]),
    userId: healed(NullableStringSchema, null).default(null),
    createdAt: lenientOptional(z.string()),
    updatedAt: lenientOptional(z.string()),
    updatedBy: lenientOptional(z.string()),
  })
  .strip();

PilotSchema satisfies z.ZodType<Omit<Pilot, "legacyId"> & { legacyId: number | null }>;
