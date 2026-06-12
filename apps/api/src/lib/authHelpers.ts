/**
 * Auth helpers — Phase 5
 *
 * JWT signing (access + refresh), bcrypt password hashing,
 * short-lived token generation/consumption, and user-index lookups.
 */

import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import * as z from "zod/v4";
import { getPrivateBlobClient, getPrivateBlockBlobClient, writePrivateBlob } from "./blob.js";
import { readJson } from "./blobJson.js";

const StringRecordSchema = z.record(z.string(), z.string());

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
  consumed?: true;
}

// ─── Token error classes ──────────────────────────────────────────────────────

export class TokenNotFoundError extends Error {
  readonly code = "TOKEN_NOT_FOUND" as const;
  constructor() {
    super("Token not found");
    this.name = "TokenNotFoundError";
  }
}

export class TokenExpiredError extends Error {
  readonly code = "TOKEN_EXPIRED" as const;
  constructor() {
    super("Token has expired");
    this.name = "TokenExpiredError";
  }
}

export class TokenAlreadyConsumedError extends Error {
  readonly code = "TOKEN_ALREADY_CONSUMED" as const;
  constructor() {
    super("Token has already been consumed");
    this.name = "TokenAlreadyConsumedError";
  }
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

const BCRYPT_COST = (() => {
  const def = 12;
  if (process.env.NODE_ENV !== "test") return def;
  const raw = process.env.TEST_BCRYPT_COST;
  if (!raw) return def;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 4) return def;
  return Math.min(parsed, def);
})();

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

export async function consumeShortLivedToken(
  raw: string,
  expectedType: "verify" | "reset"
): Promise<{ userId: string }> {
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const blobPath = `auth/tokens/${hash}.json`;
  const blockBlobClient = getPrivateBlockBlobClient(blobPath);

  let tokenDoc: AuthToken;
  let etag: string;

  try {
    const response = await blockBlobClient.download();
    etag = response.etag!;
    const chunks: Buffer[] = [];
    for await (const chunk of response.readableStreamBody!) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    tokenDoc = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as AuthToken;
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new TokenNotFoundError();
    }
    throw new Error(`Failed to read token blob auth/tokens/${hash}.json: ${String(err)}`);
  }

  if (tokenDoc.consumed) {
    console.warn("[METRIC] auth.token.reused", { tokenHash: hash });
    throw new TokenAlreadyConsumedError();
  }

  if (tokenDoc.type !== expectedType) {
    throw new TokenNotFoundError();
  }

  if (new Date(tokenDoc.expiresAt) < new Date()) {
    throw new TokenExpiredError();
  }

  const consumedDoc: AuthToken = { ...tokenDoc, consumed: true };
  const body = JSON.stringify(consumedDoc, null, 2);
  try {
    await blockBlobClient.upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { ifMatch: etag },
    });
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 412) {
      console.warn("[METRIC] auth.token.reused", { tokenHash: hash });
      throw new TokenAlreadyConsumedError();
    }
    throw new Error(`Failed to consume token blob auth/tokens/${hash}.json: ${String(err)}`);
  }

  return { userId: tokenDoc.userId };
}

// ─── User index ───────────────────────────────────────────────────────────────

/** Returns the userId for an email, or null if not registered. */
export async function lookupUserByEmail(email: string): Promise<string | null> {
  try {
    const index = await readJson(
      getPrivateBlobClient("user-index.json"),
      StringRecordSchema,
      "user-index.json",
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
