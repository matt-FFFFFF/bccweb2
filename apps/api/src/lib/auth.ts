import { HttpRequest } from "@azure/functions";
import jwt from "jsonwebtoken";
import * as z from "zod/v4";
import type { CallerIdentity, PilotEmailIndex, User } from "@bccweb/types";
import { PilotSchema, UserSchema } from "@bccweb/schemas";
import {
  ensurePrivateJsonIndexBlob,
  getPrivateBlobClient,
  withPrivateLeaseRetry,
} from "./blob.js";
import { readJson, writePrivateJson } from "./blobJson.js";
import { isUserDeleted, UserDeletedError } from "./accountMutation.js";

const StringRecordSchema = z.record(z.string(), z.string());

export class EmailIndexConflictError extends Error {
  readonly existingId: string;

  constructor(existingId: string) {
    super("Email already claimed by a different id");
    this.name = "EmailIndexConflictError";
    this.existingId = existingId;
  }
}

interface GetOrCreateUserOptions {
  readonly onIndexConflict?: "throw" | "swallow";
}

// ─── JWT validation ────────────────────────────────────────────────────────

interface AccessTokenClaims {
  sub: string;   // user UUID
  email: string;
  type: "access";
  // issue #122: optional for back-compat — a pre-deploy token has no claim and is treated as 0.
  sessionVersion?: number;
  iat: number;
  exp: number;
}

function getJwtSecret(): string {
  const secret = process.env["JWT_SECRET"];
  if (!secret) throw new Error("JWT_SECRET environment variable is not set");
  return secret;
}

function validateJwt(token: string): AccessTokenClaims {
  const claims = jwt.verify(token, getJwtSecret(), {
    algorithms: ["HS256"],
  }) as AccessTokenClaims;

  if (claims.type !== "access") {
    throw new Error("Invalid token type");
  }

  return claims;
}

// ─── User record resolution ────────────────────────────────────────────────

export async function getOrCreateUser(
  userId: string,
  email: string,
  opts: GetOrCreateUserOptions = {},
): Promise<User> {
  const userPath = `users/${userId}.json`;
  const blobClient = getPrivateBlobClient(userPath);

  try {
    return await readJson(blobClient, UserSchema, userPath);
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 404) throw err;

    if (await isUserDeleted(userId)) {
      throw new UserDeletedError(userId);
    }

    const createdAt = new Date().toISOString();

    if (opts.onIndexConflict === "swallow") {
      try {
        await updateUserIndex(email, userId);
      } catch (err: unknown) {
        if (err instanceof EmailIndexConflictError) {
          console.warn("[auth] user-index claim conflict", {
            userId,
            existingId: err.existingId,
          });
          return {
            id: userId,
            email,
            roles: [],
            pilotId: null,
            clubId: null,
            createdAt,
          };
        }
        throw err;
      }
    }

    let pilotId: string | null = null;
    let clubId: string | null = null;

    const emailIndex = await (async (): Promise<Record<string, string>> => {
      try {
        return await readJson(
          getPrivateBlobClient("pilot-email-index.json"),
          StringRecordSchema,
          "pilot-email-index.json",
        );
      } catch {
        return {};
      }
    })();
    const foundPilotId = emailIndex[email.toLowerCase()];
    if (foundPilotId) {
      try {
        const pilotPath = `pilots/${foundPilotId}.json`;
        const pilot = await readJson(
          getPrivateBlobClient(pilotPath),
          PilotSchema,
          pilotPath,
        );
        pilotId = foundPilotId;
        clubId = pilot.currentClub?.id ?? null;
      } catch (err: unknown) {
        // issue #126: a 404 means the email is claimed but the pilot blob is not yet
        // durable (claim-first in-flight window) — leave the user unlinked (auto-link is
        // best-effort at first login). Any OTHER error is unexpected/transient; do NOT
        // silently persist a permanently-unlinked user — rethrow so the request retries.
        if ((err as { statusCode?: number }).statusCode !== 404) throw err;
      }
    }

    const newUser: User = {
      id: userId,
      email,
      roles: pilotId ? ["Pilot"] : [],
      pilotId,
      clubId,
      createdAt,
    };

    await writePrivateJson(userPath, UserSchema, newUser);
    if (opts.onIndexConflict !== "swallow") {
      await updateUserIndex(email, userId);
    }

    return newUser;
  }
}

async function updateUserIndex(email: string, userId: string): Promise<void> {
  const indexPath = "user-index.json";
  await ensurePrivateJsonIndexBlob(indexPath, "{}");
  await withPrivateLeaseRetry(indexPath, async (leaseId) => {
    let index: Record<string, string> = {};
    try {
      index = await readJson(
        getPrivateBlobClient(indexPath),
        StringRecordSchema,
        indexPath,
      );
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode !== 404) throw err;
      // index doesn't exist yet; start fresh
    }

    const key = email.toLowerCase();
    const owner = index[key];
    if (owner && owner !== userId) throw new EmailIndexConflictError(owner);
    index[key] = userId;
    await writePrivateJson(indexPath, StringRecordSchema, index, leaseId);
  });
}

export async function updatePilotEmailIndex(email: string, pilotId: string): Promise<string | undefined> {
  const indexPath = "pilot-email-index.json";
  await ensurePrivateJsonIndexBlob(indexPath, "{}");
  let previousOwner: string | undefined;

  await withPrivateLeaseRetry(indexPath, async (leaseId) => {
    let index: PilotEmailIndex = {};
    try {
      index = await readJson(
        getPrivateBlobClient(indexPath),
        StringRecordSchema,
        indexPath,
      );
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode !== 404) throw err;
      // no-op
    }
    const key = email.toLowerCase();
    const owner = index[key];
    if (owner && owner !== pilotId) throw new EmailIndexConflictError(owner);
    previousOwner = owner;
    index[key] = pilotId;
    await writePrivateJson(indexPath, StringRecordSchema, index, leaseId);
  });
  return previousOwner;
}

export async function releasePilotEmailClaim(email: string, pilotId: string): Promise<void> {
  const indexPath = "pilot-email-index.json";
  await ensurePrivateJsonIndexBlob(indexPath, "{}");

  await withPrivateLeaseRetry(indexPath, async (leaseId) => {
    let index: PilotEmailIndex = {};
    try {
      index = await readJson(
        getPrivateBlobClient(indexPath),
        StringRecordSchema,
        indexPath,
      );
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404) return;
      throw err;
    }

    const key = email.toLowerCase();
    if (index[key] !== pilotId) return;
    delete index[key];
    await writePrivateJson(indexPath, StringRecordSchema, index, leaseId);
  });
}

// ─── Main middleware ───────────────────────────────────────────────────────

/**
 * Extract and validate the caller's JWT from the Authorization header,
 * look up (or create) their user record, and return a CallerIdentity.
 * Returns null if no valid token is present.
 */
export async function getCallerIdentity(
  req: HttpRequest
): Promise<CallerIdentity | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);

  let claims: AccessTokenClaims;
  try {
    claims = validateJwt(token);
  } catch {
    return null;
  }

  if (await isUserDeleted(claims.sub)) return null;

  const user = await getOrCreateUser(claims.sub, claims.email, {
    onIndexConflict: "swallow",
  });

  // issue #122: reject a token whose session was invalidated (email-change / logout / reset
  // bumps user.sessionVersion). Uses the `user` already read above → 0 extra blob ops on the
  // per-request auth hot path.
  if ((claims.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)) {
    return null;
  }

  return {
    userId: claims.sub,
    email: claims.email,
    roles: user.roles,
    pilotId: user.pilotId,
    clubId: user.clubId,
  };
}

/**
 * Returns a 401 JSON response suitable for returning from a Function when
 * auth is missing or invalid.
 */
export function unauthorizedResponse(message = "Unauthorized") {
  return { status: 401, jsonBody: { error: message } };
}

/**
 * Returns a 403 JSON response when auth succeeds but the caller lacks the
 * required role.
 */
export function forbiddenResponse(message = "Forbidden") {
  return { status: 403, jsonBody: { error: message } };
}
