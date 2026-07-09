// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Site, SiteStatus, SiteSummary } from "@bccweb/types";
import * as z from "zod/v4";

import { healed, lenientOptional, normalizeEnum } from "./helpers.js";

const siteStatusValues = ["Active", "Inactive"] as const;

const siteStatusAliases = {
  active: "Active",
  enabled: "Active",
  open: "Active",
  inactive: "Inactive",
  disabled: "Inactive",
  closed: "Inactive",
} as const satisfies Record<string, SiteStatus>;

export const SiteStatusSchema = z.preprocess(
  normalizeEnum(siteStatusValues, siteStatusAliases),
  z.enum(siteStatusValues).catch("Active"),
);

function coordinateSchema(min: number, max: number): z.ZodType<number | null> {
  return z
    .number()
    .min(min)
    .max(max)
    .nullable()
    // Bad legacy coordinates are typos; heal to null rather than failing reads.
    .catch(null);
}

export const SiteSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: SiteStatusSchema.default("Active"),
    clubId: healed(z.string(), "").default(""),
  })
  .strip();

SiteStatusSchema satisfies z.ZodType<SiteStatus>;
SiteSummarySchema satisfies z.ZodType<SiteSummary>;

export const SiteSchema = SiteSummarySchema.extend({
  legacyId: lenientOptional(z.number().int()),
  parkingW3W: lenientOptional(z.string()),
  briefingW3W: lenientOptional(z.string()),
  takeOffW3W: lenientOptional(z.string()),
  guideUrl: lenientOptional(z.string()),
  contactInfo: lenientOptional(z.string()),
  createdAt: lenientOptional(z.string()),
  updatedAt: lenientOptional(z.string()),
  updatedBy: lenientOptional(z.string()),
  lat: coordinateSchema(-90, 90).default(null),
  lng: coordinateSchema(-180, 180).default(null),
}).strip();

SiteSchema satisfies z.ZodType<Site>;
