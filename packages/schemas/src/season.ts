// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { LeagueEntry, Season, SeasonSummary } from "@bccweb/types";
import * as z from "zod/v4";

import { healed, healingArray, lenientOptional } from "./helpers.js";

const YearSchema = z.coerce.number().int().min(2000).max(9999);

const NullableDateSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)))
  .nullable()
  .catch(null);

const RoundScoresSchema = z.record(z.string(), healed(z.number(), 0)).catch({});

const SeasonSummaryShape = {
  id: healed(z.string().min(1), ""),
  year: YearSchema,
  active: healed(z.boolean(), false).default(false),
  start: lenientOptional(NullableDateSchema),
  end: lenientOptional(NullableDateSchema),
} as const;

function fillSeasonId<T extends { id: string; year: number }>(season: T): T {
  return {
    ...season,
    id: season.id || `season-${season.year}`,
  };
}

export const SeasonSummarySchema = z
  .object(SeasonSummaryShape)
  .strip()
  .transform(fillSeasonId);

SeasonSummarySchema satisfies z.ZodType<SeasonSummary>;

export const LeagueEntrySchema = z
  .object({
    rank: healed(z.number().int(), 0).default(0),
    clubId: healed(z.string(), "").default(""),
    clubName: healed(z.string(), "").default(""),
    teamName: healed(z.string(), "").default(""),
    totalScore: healed(z.number(), 0).default(0),
    roundScores: RoundScoresSchema.default({}),
    countedRounds: healed(z.number().int(), 0).default(0),
  })
  .strip();

LeagueEntrySchema satisfies z.ZodType<LeagueEntry>;

export const SeasonSchema = z
  .object({
    ...SeasonSummaryShape,
    rounds: healingArray(z.string()).default([]),
    leagueTable: healingArray(LeagueEntrySchema).default([]),
    legacyId: lenientOptional(z.number().int()),
  })
  .strip()
  .transform(fillSeasonId);

SeasonSchema satisfies z.ZodType<Season>;
