/**
 * Auth helpers — Phase 5
 *
 * JWT signing (access + refresh), bcrypt password hashing,
 * short-lived token generation/consumption, and user-index lookups.
 */

import crypto, { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import * as z from "zod/v4";
import { AuthCredentialSchema } from "@bccweb/schemas";
import { getPrivateBlobClient, getPrivateBlockBlobClient, writePrivateBlob } from "./blob.js";
import { readJson } from "./blobJson.js";
import { isUserDeleted } from "./accountMutation.js";
import { sendEmail, verificationEmailHtml, verificationEmailText } from "./email.js";

const StringRecordSchema = z.record(z.string(), z.string());

// ─── Internal types ───────────────────────────────────────────────────────────

export interface AuthCredential {
  passwordHash: string;
  emailVerified: boolean;
  createdAt: string;
  tokenVersion?: number;
}

export interface AuthToken {
  userId: string;
  type: "verify" | "reset";
  expiresAt: string;
  tokenVersion?: number;
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

export function signAccessToken(userId: string, email: string, sessionVersion: number): string {
  return jwt.sign(
    { sub: userId, email, type: "access", sessionVersion },
    getJwtSecret(),
    { algorithm: "HS256", expiresIn: "1h" }
  );
}

export function signRefreshToken(userId: string, tokenVersion: number): string {
  return jwt.sign(
    { sub: userId, type: "refresh", tokenVersion },
    getJwtSecret(),
    { algorithm: "HS256", expiresIn: "30d" }
  );
}

/**
 * Verify a refresh token and return its userId + tokenVersion claim. Rejects a
 * non-object payload, a missing/empty subject, a non-"refresh" type, or a
 * missing/malformed (non-integer / negative) version. Throws if invalid/expired.
 */
export function verifyRefreshToken(token: string): { userId: string; tokenVersion: number } {
  const claims = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] });
  if (typeof claims !== "object" || claims === null) {
    throw new Error("Invalid token payload");
  }
  const { sub, type, tokenVersion } = claims as { sub?: unknown; type?: unknown; tokenVersion?: unknown };
  if (type !== "refresh") throw new Error("Invalid token type");
  if (typeof sub !== "string" || sub.length === 0) throw new Error("Invalid token subject");
  if (typeof tokenVersion !== "number" || !Number.isInteger(tokenVersion) || tokenVersion < 0) {
    throw new Error("Invalid token version");
  }
  return { userId: sub, tokenVersion };
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
  const authPath = `auth/${userId}.json`;
  const credential = await readJson(
    getPrivateBlobClient(authPath),
    AuthCredentialSchema,
    authPath,
  );

  const tokenDoc: AuthToken = { userId, type, expiresAt, tokenVersion: credential.tokenVersion ?? 0 };
  await writePrivateBlob(`auth/tokens/${hash}.json`, tokenDoc);
  return raw;
}

export async function consumeShortLivedToken(
  raw: string,
  expectedType: "verify" | "reset"
): Promise<{ userId: string; tokenVersion: number }> {
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
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

  return { userId: tokenDoc.userId, tokenVersion: tokenDoc.tokenVersion ?? 0 };
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
    const userId = index[email.toLowerCase()] ?? null;
    if (!userId) return null;
    return (await isUserDeleted(userId)) ? null : userId;
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

// ─── Email-verification tokens ──────────────────────────────────────────────

export interface VerificationState {
  token: string;
  createdAt: string;
  expiresAt: string;
}

export function verificationStatePath(userId: string): string {
  return `auth/verification-state/${userId}.json`;
}

export async function storeVerificationToken(
  userId: string,
  rawToken: string,
  ttlHours: number
): Promise<VerificationState> {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const tokenDoc: VerificationState = { token: rawToken, createdAt, expiresAt };
  const authPath = `auth/${userId}.json`;
  const credential = await readJson(
    getPrivateBlobClient(authPath),
    AuthCredentialSchema,
    authPath,
  );

  // CREATE-ONCE: token path is sha256-keyed, collision means token already issued
  await writePrivateBlob(`auth/tokens/${tokenHash}.json`, {
    userId,
    type: "verify",
    createdAt,
    expiresAt,
    tokenVersion: credential.tokenVersion ?? 0,
  });
  // CREATE-ONCE: token path is sha256-keyed, collision means token already issued
  await writePrivateBlob(verificationStatePath(userId), tokenDoc);
  return tokenDoc;
}

export async function createVerificationToken(userId: string, ttlHours: number): Promise<VerificationState> {
  const rawToken = randomBytes(32).toString("hex");
  return storeVerificationToken(userId, rawToken, ttlHours);
}

export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const verifyUrl = `${getAppUrl()}/verify-email?token=${token}`;
  try {
    await sendEmail({
      to: [email],
      subject: "Verify your BCC account",
      html: verificationEmailHtml(verifyUrl),
      text: verificationEmailText(verifyUrl),
    });
  } catch (err) {
    console.error("[auth/register] Failed to send verification email:", err);
  }
}
