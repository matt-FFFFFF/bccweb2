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

// ─── JWT validation ────────────────────────────────────────────────────────

interface AccessTokenClaims {
  sub: string;   // user UUID
  email: string;
  type: "access";
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
  email: string
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

    let pilotId: string | null = null;
    let clubId: string | null = null;

    try {
      const emailIndex = await readJson(
        getPrivateBlobClient("pilot-email-index.json"),
        StringRecordSchema,
        "pilot-email-index.json",
      );
      const foundPilotId = emailIndex[email.toLowerCase()];
      if (foundPilotId) {
        pilotId = foundPilotId;
        try {
          const pilotPath = `pilots/${foundPilotId}.json`;
          const pilot = await readJson(
            getPrivateBlobClient(pilotPath),
            PilotSchema,
            pilotPath,
          );
          clubId = pilot.currentClub?.id ?? null;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    const newUser: User = {
      id: userId,
      email,
      roles: pilotId ? ["Pilot"] : [],
      pilotId,
      clubId,
      createdAt: new Date().toISOString(),
    };

    await writePrivateJson(userPath, UserSchema, newUser);
    await updateUserIndex(email, userId);

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

    index[email.toLowerCase()] = userId;
    await writePrivateJson(indexPath, StringRecordSchema, index, leaseId);
  });
}

export async function updatePilotEmailIndex(email: string, pilotId: string): Promise<void> {
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
      if (statusCode !== 404) throw err;
      // no-op
    }
    index[email.toLowerCase()] = pilotId;
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

  const user = await getOrCreateUser(claims.sub, claims.email);

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
