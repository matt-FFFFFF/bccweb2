import { HttpRequest } from "@azure/functions";
import jwt from "jsonwebtoken";
import type { CallerIdentity, User } from "@bccweb/types";
import { getBlobClient, readBlob, writeBlob } from "./blob.js";

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
  const blobClient = getBlobClient(userPath);

  try {
    return await readBlob<User>(blobClient);
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 404) throw err;

    // First login — auto-link via email match against pilot index
    let pilotId: string | null = null;
    let clubId: string | null = null;

    try {
      const pilotIndex = await readBlob<
        Array<{ id: string; email?: string; clubId?: string }>
      >(getBlobClient("pilots.json"));

      const match = pilotIndex.find(
        (p) => p.email?.toLowerCase() === email.toLowerCase()
      );

      if (match) {
        pilotId = match.id;
        clubId = match.clubId ?? null;
      }
    } catch {
      // pilots.json may not exist yet (pre-migration); treat as no match
    }

    const newUser: User = {
      id: userId,
      email,
      roles: pilotId ? ["Pilot"] : [],
      pilotId,
      clubId,
      createdAt: new Date().toISOString(),
    };

    await writeBlob(userPath, newUser);
    await updateUserIndex(email, userId);

    return newUser;
  }
}

async function updateUserIndex(email: string, userId: string): Promise<void> {
  const indexPath = "user-index.json";

  let index: Record<string, string> = {};
  try {
    index = await readBlob<Record<string, string>>(
      getBlobClient(indexPath)
    );
  } catch {
    // index doesn't exist yet; start fresh
  }

  index[email.toLowerCase()] = userId;
  await writeBlob(indexPath, index);
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
