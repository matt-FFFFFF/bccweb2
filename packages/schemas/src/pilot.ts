// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  COACH_TYPES,
  PILOT_RATINGS,
  WING_CLASSES,
  type Pilot,
  type PilotSummary,
} from "@bccweb/types";
import * as z from "zod/v4";

import { healed, healingArray, lenientOptional } from "./helpers.js";

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

const CoachTypeSchema = z.enum(COACH_TYPES);

const PilotRatingSchema = z.enum(PILOT_RATINGS);

const WingClassSchema = z.enum(WING_CLASSES);

export const PilotSummarySchema = z
  .object({
    id: z.string().min(1),
    legacyId: HealedLegacyIdSchema,
    name: z.string().min(1),
    clubId: lenientOptional(z.string()),
    rating: lenientOptional(PilotRatingSchema),
  })
  .strip();

PilotSummarySchema satisfies z.ZodType<PilotSummary>;

export const PilotSchema = z
  .object({
    id: z.string().min(1),
    legacyId: HealedLegacyIdSchema,
    bhpaNumber: lenientOptional(z.number()),
    coachType: healed(CoachTypeSchema, "None").default("None"),
    pilotRating: healed(PilotRatingSchema, "Club Pilot").default("Club Pilot"),
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

PilotSchema satisfies z.ZodType<Pilot>;
