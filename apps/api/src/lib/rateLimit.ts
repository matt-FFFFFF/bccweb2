/**
 * Rate limiting and account lockout helpers for /api/auth/* endpoints.
 *
 * Rate limiting: in-memory token-bucket keyed by (ip, endpoint).
 * Cold-start resets the bucket (acceptable for consumption-plan Functions).
 *
 * Lockout: persistent per-account state stored in auth/{userId}.json.
 * 5 wrong-password attempts in 10 minutes -> 15-minute lockout.
 * Lockout by IP is intentionally omitted — paragliding meets share NAT.
 */

import { createHash } from "crypto";
import type { HttpRequest } from "@azure/functions";
import type { CallerIdentity } from "@bccweb/types";
import { AuthCredentialSchema } from "@bccweb/schemas";
import { getPrivateBlobClient, withPrivateLease } from "./blob.js";
import { readJson, writePrivateJson } from "./blobJson.js";
import { HttpError } from "./http.js";

// ─── Token Bucket ─────────────────────────────────────────────────────────────

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMin: number
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillMs;
    const added = (elapsedMs / 60_000) * this.refillPerMin;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefillMs = now;
  }

  /** Consume one token. Returns true if a token was available, false if empty. */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Refill bucket to capacity (used in tests and for manual reset). */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillMs = Date.now();
  }

  /** Lower-bound seconds until the next token is available. */
  retryAfterSecs(): number {
    const msPerToken = 60_000 / this.refillPerMin;
    return Math.ceil(msPerToken / 1000);
  }
}

// ─── In-memory bucket registry ────────────────────────────────────────────────

const _buckets = new Map<string, TokenBucket>();

/** Clear all in-memory buckets. Intended for test isolation only. */
export function resetAllBuckets(): void {
  _buckets.clear();
}

// ─── Rate limit ───────────────────────────────────────────────────────────────

export interface RateLimitOpts {
  endpoint: string;
  capacity: number;
  refillPerMin: number;
  /** When provided, used as the bucket key instead of the request IP.
   *  Use for authenticated endpoints where per-identity limiting is desired
   *  (e.g., register-self uses caller.pilotId). When absent, falls back to IP.
   *  This fixes the shared-NAT problem where multiple pilots on the same
   *  network (same hill, same router) would share a single IP-keyed budget. */
  identityKey?: string;
}

/**
 * Token-bucket rate limiter keyed by (identityKey ?? IP, endpoint).
 *
 * Source IP is read from x-forwarded-for (first entry) or x-azure-clientip.
 * Falls back to "unknown" if neither header is present. When opts.identityKey
 * is supplied, it replaces the IP component of the bucket key.
 *
 * Throws HttpError(429, "RATE_LIMITED") with a Retry-After header when the
 * bucket is exhausted. Emits [METRIC] auth.rateLimit.hit on every rejection.
 */
export function rateLimit(req: HttpRequest, opts: RateLimitOpts): void {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-azure-clientip") ??
    "unknown";

  const keyPart = opts.identityKey ?? ip;
  const key = `${keyPart}:${opts.endpoint}`;
  let bucket = _buckets.get(key);
  if (!bucket) {
    bucket = new TokenBucket(opts.capacity, opts.refillPerMin);
    _buckets.set(key, bucket);
  }

  if (!bucket.tryConsume()) {
    console.warn(`[METRIC] auth.rateLimit.hit endpoint=${opts.endpoint}`);
    throw new HttpError(
      429,
      "RATE_LIMITED",
      "Too many requests; try again later.",
      { "Retry-After": String(bucket.retryAfterSecs()) }
    );
  }
}

// ─── Mutation rate limit ──────────────────────────────────────────────────────

// Tier table (capacity/min : burst capacity, refillPerMin):
//   standard : 30/min  — admin/reference data writes
//   heavy    :  5/min  — round lock/complete/recompute, brief PDF build, PureTrack group create
//   flights  : 60/min  — pilot hillside logging (legitimate burst)
const MUTATION_TIERS = {
  standard: { capacity: 30, refillPerMin: 30 },
  heavy: { capacity: 5, refillPerMin: 5 },
  flights: { capacity: 60, refillPerMin: 60 },
} as const;

export type MutationRateLimitTier = keyof typeof MUTATION_TIERS;

/**
 * Per-identity mutation rate limiter for authenticated write endpoints.
 *
 * MUST be called AFTER the auth/role check — `caller.userId` is the bucket key
 * via the existing `identityKey` option, so unauthenticated callers (with no
 * userId) must never reach this point. Throws HttpError(429, "RATE_LIMITED")
 * with a Retry-After header when the per-tier bucket is exhausted.
 */
export async function mutationRateLimit(
  req: HttpRequest,
  caller: CallerIdentity,
  endpoint: string,
  tier: MutationRateLimitTier
): Promise<void> {
  const { capacity, refillPerMin } = MUTATION_TIERS[tier];
  rateLimit(req, {
    endpoint: `mutation:${tier}:${endpoint}`,
    capacity,
    refillPerMin,
    identityKey: caller.userId,
  });
}

// ─── Lockout constants ────────────────────────────────────────────────────────

const FAILURE_WINDOW_MS = 10 * 60_000; // 10 minutes
const MAX_FAILURES = 5;
const LOCKOUT_DURATION_MS = 15 * 60_000; // 15 minutes

// ─── Internal types ───────────────────────────────────────────────────────────

// Credential shape is owned by AuthCredentialSchema (@bccweb/schemas). The
// schema is a strict superset of the lockout fields touched here — see
// .omo/evidence/task-42-lockout-superset.txt for the audit.

function sha8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

// ─── Lockout helpers ──────────────────────────────────────────────────────────

/**
 * Check whether the account is currently locked.
 *
 * Reads auth/{userId}.json and throws HttpError(423, "ACCOUNT_LOCKED") if
 * lockedUntil > now. Returns silently if the blob is missing (tolerated edge
 * case during account setup) or if the lockout has expired.
 */
export async function checkAccountLockout(userId: string): Promise<void> {
  const path = `auth/${userId}.json`;
  let cred;
  try {
    cred = await readJson(getPrivateBlobClient(path), AuthCredentialSchema, path);
  } catch {
    return; // blob missing — no lockout to enforce
  }

  if (cred.lockedUntil && new Date(cred.lockedUntil) > new Date()) {
    throw new HttpError(
      423,
      "ACCOUNT_LOCKED",
      "Account temporarily locked due to repeated login failures."
    );
  }
}

/**
 * Record a failed login attempt for the given userId.
 *
 * Under a 30-second private blob lease, increments the failure list (pruned to
 * the last 10 minutes). If the running total reaches MAX_FAILURES and the
 * account is not already locked, sets lockedUntil = now + 15 minutes and emits
 * [METRIC] auth.lockout.triggered.
 *
 * Silently returns if auth/{userId}.json does not exist (blob may have been
 * deleted between the caller's initial read and this call).
 */
export async function recordLoginFailure(userId: string): Promise<void> {
  const path = `auth/${userId}.json`;
  try {
    await withPrivateLease(path, async (leaseId) => {
      const cred = await readJson(
        getPrivateBlobClient(path),
        AuthCredentialSchema,
        path,
      );

      const now = Date.now();
      const windowStart = now - FAILURE_WINDOW_MS;

      const recentFailures = (cred.failedAttempts ?? []).filter(
        (t) => new Date(t).getTime() >= windowStart
      );
      recentFailures.push(new Date(now).toISOString());
      cred.failedAttempts = recentFailures;

      const isCurrentlyLocked =
        !!cred.lockedUntil &&
        new Date(cred.lockedUntil).getTime() > now;

      if (recentFailures.length >= MAX_FAILURES && !isCurrentlyLocked) {
        cred.lockedUntil = new Date(now + LOCKOUT_DURATION_MS).toISOString();
        console.warn(`[METRIC] auth.lockout.triggered userId=${sha8(userId)}`);
      }

      await writePrivateJson(path, AuthCredentialSchema, cred, leaseId);
    });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return;
    throw err;
  }
}

/**
 * Reset the failure counter and lockout on a successful login.
 *
 * Under a 30-second private blob lease, clears failedAttempts and sets
 * lockedUntil to null. Silently returns if the blob is missing.
 */
export async function recordLoginSuccess(userId: string): Promise<void> {
  const path = `auth/${userId}.json`;
  try {
    await withPrivateLease(path, async (leaseId) => {
      const cred = await readJson(
        getPrivateBlobClient(path),
        AuthCredentialSchema,
        path,
      );
      cred.failedAttempts = [];
      cred.lockedUntil = null;
      await writePrivateJson(path, AuthCredentialSchema, cred, leaseId);
    });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return;
    throw err;
  }
}
