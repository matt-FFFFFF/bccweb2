// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Signature, SignToFlyWording } from "@bccweb/types";
import * as z from "zod/v4";

import { lenientOptional } from "./helpers.js";

export const SignToFlyWordingSchema = z
  .object({
    version: z.number().int().min(1),
    hash: z.string().min(1),
    markdown: z.string(),
    createdAt: z.string().min(1),
    createdBy: z.string().min(1),
    supersededAt: lenientOptional(z.string()),
    supersededBy: lenientOptional(z.number().int()),
  })
  .strip();

SignToFlyWordingSchema satisfies z.ZodType<SignToFlyWording>;

export const ActiveWordingPointerSchema = z
  .object({
    activeVersion: z.number().int().min(1),
  })
  .strip();

const signatureSourceValues = [
  "pilot-self",
  "coord-override",
  "legacy-migrated",
] as const;

export const SignatureLedgerSchema = z
  .object({
    id: z.string().min(1),
    roundId: z.string().min(1),
    teamId: z.string().min(1),
    place: z.number().int(),
    pilotId: z.string().min(1),
    userId: z.string().min(1),
    signedAt: z.string().nullable(),
    briefVersion: z.number().int().nullable(),
    briefHash: z.string().nullable(),
    wordingVersion: z.number().int().min(1).nullable(),
    wordingHash: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    source: z.enum(signatureSourceValues),
    overrideReason: lenientOptional(z.string()),
    overrideBy: lenientOptional(z.string()),
    createdAt: lenientOptional(z.string()),
    updatedAt: lenientOptional(z.string()),
    updatedBy: lenientOptional(z.string()),
    legacyId: lenientOptional(z.number().int()),
  })
  .strip();

SignatureLedgerSchema satisfies z.ZodType<Signature>;
