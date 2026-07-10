// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type {
  BriefPilotEntry,
  BriefTeamEntry,
  BriefVersion,
  ManufacturerRef,
  PilotSnapshot,
  RoundBrief,
} from "@bccweb/types";
import { COACH_TYPES, PILOT_RATINGS, WING_CLASSES } from "@bccweb/types";
import * as z from "zod/v4";

import { healed, healingArray, lenientOptional } from "./helpers.js";

// Brief image uploads are capped by the API at 10 per brief. The schema enforces
// that storage contract so over-cap blobs fail clearly instead of being silently
// treated as valid brief documents.

const PilotRatingSchema = z.enum(PILOT_RATINGS);

const WingClassSchema = z.enum(WING_CLASSES);

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
          bhpaCoachLevel: lenientOptional(z.enum(COACH_TYPES)),
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

// Single source of truth for SAFETY-MATERIAL brief fields (B5 one-declaration):
// editing any invalidates prior sign-to-fly signatures. The sign-to-fly hash
// re-exports this; BRIEF_EDITABLE_KEYS derives from it — so neither can drift.
// `satisfies keyof RoundBrief` rejects nested `site.*W3W` paths that once silently
// dropped W3W edits from the hash.
export const MATERIAL_BRIEF_FIELDS = [
  "briefingTime",
  "checkInByTime",
  "landByTime",
  "windSpeedDirection",
  "directionOfFlight",
  "expectedLandingArea",
  "airspaceAndHazards",
  "NOTAMs",
  "BENO_LineDescription",
  "briefersNotes",
  "frequencyMhz",
  "parkingW3W",
  "briefingW3W",
  "takeOffW3W",
  "imagePaths",
] as const satisfies readonly (keyof RoundBrief)[];

// PUT-editable subset = material fields MINUS imagePaths (image-endpoint-only) PLUS
// the cosmetic `briefer` block (PUT-editable but non-material).
export const BRIEF_EDITABLE_KEYS = [
  ...MATERIAL_BRIEF_FIELDS.filter((f) => f !== "imagePaths"),
  "briefer",
] as const satisfies readonly (keyof RoundBrief)[];

// Editable schema derived from the same key list (kept in lockstep). A partial edit
// body validates without identity/derived fields; full BriefSchema validates the write.
const briefEditableMask = Object.fromEntries(
  BRIEF_EDITABLE_KEYS.map((key) => [key, true] as const),
) as Record<(typeof BRIEF_EDITABLE_KEYS)[number], true>;

export const BriefEditableSchema = BriefSchema.partial().pick(briefEditableMask);
