import type { User, UserRole } from "@bccweb/types";
import * as z from "zod/v4";

import { healed, healingArray, lenientOptional, normalizeEnum } from "./helpers.js";

const userRoleValues = ["Admin", "RoundsCoord", "Pilot"] as const;

interface AuthCredential {
  passwordHash: string;
  emailVerified: boolean;
  createdAt: string;
  failedAttempts?: string[];
  failedAttemptCount?: number;
  lockedUntil?: string | null;
  tokenVersion?: number;
}

const userRoleAliases = {
  admin: "Admin",
  administrator: "Admin",
  rounds_coord: "RoundsCoord",
  roundscoord: "RoundsCoord",
  roundsCoordinator: "RoundsCoord",
  RoundsCoordinator: "RoundsCoord",
  RoundCoordinator: "RoundsCoord",
  clubCoordinator: "RoundsCoord",
  ClubCoordinator: "RoundsCoord",
  pilot: "Pilot",
} as const satisfies Record<string, UserRole>;

export function normalizeRoles(raw: unknown): UserRole[] {
  const normalizeRole = normalizeEnum(userRoleValues, userRoleAliases);
  const rawRoles = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const roles: UserRole[] = [];

  for (const rawRole of rawRoles) {
    const role = normalizeRole(rawRole);
    if (role && !roles.includes(role)) {
      roles.push(role);
    }
  }

  return roles;
}

const NullableStringSchema = z.string().nullable();
const EpochIsoString = new Date(0).toISOString();

export const UserSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().min(1),
    roles: z.preprocess(
      (raw) => normalizeRoles(raw),
      z.array(z.enum(userRoleValues)),
    ),
    pilotId: healed(NullableStringSchema, null),
    clubId: healed(NullableStringSchema, null),
    createdAt: healed(z.string(), EpochIsoString),
    acceptedTsCsAt: lenientOptional(z.string()),
    acceptedTsCsIp: lenientOptional(NullableStringSchema),
    acceptedTsCsVersion: lenientOptional(z.number()),
  })
  .strip();

UserSchema satisfies z.ZodType<User>;

export const AuthCredentialSchema = z
  .object({
    passwordHash: z.string().min(1),
    emailVerified: healed(z.boolean(), false),
    createdAt: healed(z.string(), EpochIsoString),
    failedAttempts: lenientOptional(healingArray(z.string())),
    failedAttemptCount: lenientOptional(z.number().int().nonnegative()),
    lockedUntil: lenientOptional(NullableStringSchema),
    tokenVersion: lenientOptional(z.number().int().nonnegative()),
  })
  .strip();

AuthCredentialSchema satisfies z.ZodType<AuthCredential>;
