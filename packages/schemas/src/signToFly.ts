import * as z from "zod/v4";

import { lenientOptional } from "./helpers.js";

export const SignToFlyWordingSchema = z
  .object({
    version: z.number().int().min(1),
    html: z.string(),
    plainText: z.string(),
    publishedAt: z.string().min(1),
    publishedBy: z.string().min(1),
  })
  .strip();

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
    pilotId: z.string().min(1),
    roundId: z.string().min(1),
    wordingVersion: z.number().int().min(1),
    id: lenientOptional(z.string()),
    teamId: lenientOptional(z.string()),
    place: lenientOptional(z.number().int()),
    userId: lenientOptional(z.string()),
    signedAt: lenientOptional(z.string().nullable()),
    briefVersion: lenientOptional(z.number().int().nullable()),
    briefHash: lenientOptional(z.string().nullable()),
    wordingHash: lenientOptional(z.string().nullable()),
    ip: lenientOptional(z.string().nullable()),
    userAgent: lenientOptional(z.string().nullable()),
    source: lenientOptional(z.enum(signatureSourceValues)),
    overrideReason: lenientOptional(z.string()),
    overrideBy: lenientOptional(z.string()),
    createdAt: lenientOptional(z.string()),
    updatedAt: lenientOptional(z.string()),
    updatedBy: lenientOptional(z.string()),
    legacyId: lenientOptional(z.number().int()),
  })
  .strip();
