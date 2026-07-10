// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Club, ClubSummary } from "@bccweb/types";
import * as z from "zod/v4";

import { healingArray, lenientOptional } from "./helpers.js";

export const ClubSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strip();

ClubSummarySchema satisfies z.ZodType<ClubSummary>;

export const ClubSchema = ClubSummarySchema.extend({
  legacyId: lenientOptional(z.number()),
  sites: healingArray(z.string()).default([]),
  teams: lenientOptional(healingArray(z.string())),
  createdAt: lenientOptional(z.string()),
  updatedAt: lenientOptional(z.string()),
  updatedBy: lenientOptional(z.string()),
}).strip();

ClubSchema satisfies z.ZodType<Club>;
