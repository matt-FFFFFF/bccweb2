// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { ClubTeam, ClubTeamSummary } from "@bccweb/types";
import * as z from "zod/v4";

export const ClubTeamSummarySchema = z
  .object({
    id: z.string().min(1),
    clubId: z.string().min(1),
    clubName: z.string().min(1),
    seasonYear: z.number().int(),
    teamName: z.string().min(1),
  })
  .strip();

ClubTeamSummarySchema satisfies z.ZodType<ClubTeamSummary>;

export const ClubTeamSchema = ClubTeamSummarySchema.extend({
  createdAt: z.string().min(1),
  legacyId: z.number().int().optional(),
}).strip();

ClubTeamSchema satisfies z.ZodType<ClubTeam>;
