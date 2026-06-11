// NOTE: The 'frequency' field is removed in Wave 7 (Task 45). When that lands,
// the field is deleted from this schema and from packages/types; enforce-mode
// healing then strips the dead field from stored season-clubs/* blobs
// transaction-by-transaction — the intended cleanup. Do NOT remove 'frequency'
// here pre-emptively — that breaks Wave 6 mechanical migration which still
// types blob writes with the current field.

import type { Frequency, SeasonClub } from "@bccweb/types";
import * as z from "zod/v4";

export const FrequencySchema = z
  .object({
    id: z.string().min(1).catch("").default(""),
    label: z.string().min(1),
    position: z.number().int(),
    legacyId: z.number().int().optional(),
  })
  .strip();

FrequencySchema satisfies z.ZodType<Frequency>;

export const SeasonClubSchema = z
  .object({
    id: z.string().min(1),
    seasonYear: z.number().int(),
    clubId: z.string().min(1),
    numTeams: z.number().int(),
    acceptedTsCs: z.boolean(),
    acceptedTsCsAt: z.string().min(1).optional(),
    acceptedTsCsBy: z.string().min(1).optional(),
    frequency: FrequencySchema.optional(),
    createdAt: z.string().min(1).optional(),
    updatedAt: z.string().min(1).optional(),
    updatedBy: z.string().min(1).optional(),
    legacyId: z.number().int().optional(),
  })
  .strip();

SeasonClubSchema satisfies z.ZodType<SeasonClub>;
