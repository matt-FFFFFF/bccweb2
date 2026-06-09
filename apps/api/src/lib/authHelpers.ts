/**
 * Auth helpers — Phase 5
 *
 * JWT signing (access + refresh), bcrypt password hashing,
 * short-lived token generation/consumption, and user-index lookups.
 */

import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getPrivateBlobClient, getPrivateBlockBlobClient, readBlob, writePrivateBlob } from "./blob.js";

// ─── Internal types ───────────────────────────────────────────────────────────

export interface AuthCredential {
  passwordHash: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface AuthToken {
  userId: string;
  type: "verify" | "reset";
  expiresAt: string;
}

// ─── JWT ──────────────────────────────────────────────────────────────────────

function getJwtSecret(): string {
  const s = process.env["JWT_SECRET"];
  if (!s) throw new Error("JWT_SECRET environment variable is not set");
  return s;
}

export function signAccessToken(userId: string, email: string): string {
  return jwt.sign(
    { sub: userId, email, type: "access" },
    getJwtSecret(),
    { algorithm: "HS256", expiresIn: "1h" }
  );
}

export function signRefreshToken(userId: string): string {
  return jwt.sign(
    { sub: userId, type: "refresh" },
    getJwtSecret(),
    { algorithm: "HS256", expiresIn: "30d" }
  );
}

/**
 * Verify a refresh token and return the userId (sub claim).
 * Throws if invalid or expired.
 */
export function verifyRefreshToken(token: string): string {
  const claims = jwt.verify(token, getJwtSecret(), {
    algorithms: ["HS256"],
  }) as { sub: string; type: string };
  if (claims.type !== "refresh") throw new Error("Invalid token type");
  return claims.sub;
}

// ─── Password ─────────────────────────────────────────────────────────────────

const BCRYPT_COST = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ─── Short-lived tokens ───────────────────────────────────────────────────────

/**
 * Generate a random hex token, store its SHA-256 hash in blob, and return
 * the raw token for inclusion in an email link.
 */
export async function generateShortLivedToken(
  userId: string,
  type: "verify" | "reset",
  ttlHours: number
): Promise<string> {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expiresAt = new Date(
    Date.now() + ttlHours * 3_600_000
  ).toISOString();

  const tokenDoc: AuthToken = { userId, type, expiresAt };
  await writePrivateBlob(`auth/tokens/${hash}.json`, tokenDoc);
  return raw;
}

/**
 * Consume a raw token: validate type + expiry, delete on first use,
 * and return the associated userId.
 */
export async function consumeShortLivedToken(
  raw: string,
  expectedType: "verify" | "reset"
): Promise<{ userId: string } | { error: string }> {
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const blobPath = `auth/tokens/${hash}.json`;

  let tokenDoc: AuthToken;
  try {
    tokenDoc = await readBlob<AuthToken>(getPrivateBlobClient(blobPath));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { error: "Invalid or expired token" };
    }
    throw err;
  }

  if (tokenDoc.type !== expectedType) return { error: "Invalid token type" };
  if (new Date(tokenDoc.expiresAt) < new Date()) {
    return { error: "Token has expired" };
  }

  // Delete on first use (best-effort)
  try {
    await getPrivateBlockBlobClient(blobPath).delete();
  } catch {
    // Ignore — the expiry check is the real guard
  }

  return { userId: tokenDoc.userId };
}

// ─── User index ───────────────────────────────────────────────────────────────

/** Returns the userId for an email, or null if not registered. */
export async function lookupUserByEmail(email: string): Promise<string | null> {
  try {
    const index = await readBlob<Record<string, string>>(
      getPrivateBlobClient("user-index.json")
    );
    return index[email.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

// ─── App URL ──────────────────────────────────────────────────────────────────

/** Base URL for email links. Reads APP_URL env var or falls back to WEBSITE_HOSTNAME. */
export function getAppUrl(): string {
  const appUrl = process.env["APP_URL"];
  if (appUrl) return appUrl.replace(/\/$/, "");
  const hostname = process.env["WEBSITE_HOSTNAME"];
  if (hostname) return `https://${hostname}`;
  return "http://localhost:5173";
}
