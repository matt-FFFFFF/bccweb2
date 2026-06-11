import { randomUUID } from "crypto";
import { describe, expect, test, vi } from "vitest";
import type { HttpRequest } from "@azure/functions";
import type { CallerIdentity } from "@bccweb/types";
import { getPrivateBlobClient, readBlob, writePrivateBlob } from "../blob.js";
import { HttpError } from "../http.js";
import {
  TokenBucket,
  checkAccountLockout,
  mutationRateLimit,
  rateLimit,
  recordLoginFailure,
  recordLoginSuccess,
  resetAllBuckets,
} from "../rateLimit.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(ip = "1.2.3.4"): HttpRequest {
  const headers = new Headers();
  headers.set("x-forwarded-for", ip);
  return { headers } as unknown as HttpRequest;
}

async function seedAuthBlob(userId: string): Promise<void> {
  await writePrivateBlob(`auth/${userId}.json`, {
    passwordHash: "$2b$12$placeholder",
    emailVerified: true,
    createdAt: new Date().toISOString(),
    failedAttempts: [],
    lockedUntil: null,
  });
}

// ─── TokenBucket unit tests ───────────────────────────────────────────────────

describe("TokenBucket", () => {
  test("starts full and allows up to capacity requests", () => {
    const bucket = new TokenBucket(3, 60);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  test("reset fills bucket to capacity", () => {
    const bucket = new TokenBucket(2, 60);
    bucket.tryConsume();
    bucket.tryConsume();
    expect(bucket.tryConsume()).toBe(false);
    bucket.reset();
    expect(bucket.tryConsume()).toBe(true);
  });
});

// ─── rateLimit() ─────────────────────────────────────────────────────────────

describe("rateLimit", () => {
  test("11 login requests from same IP -> 11th throws HttpError 429 RATE_LIMITED", () => {
    resetAllBuckets();
    const req = makeReq("10.0.0.1");
    const opts = { endpoint: "login", capacity: 10, refillPerMin: 10 };
    for (let i = 0; i < 10; i++) {
      rateLimit(req, opts);
    }
    let caught: unknown;
    try {
      rateLimit(req, opts);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(429);
    expect((caught as HttpError).code).toBe("RATE_LIMITED");
  });

  test("[METRIC] auth.rateLimit.hit emitted on rejection", () => {
    resetAllBuckets();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const req = makeReq("10.0.0.2");
      const opts = { endpoint: "login-metric-t16", capacity: 1, refillPerMin: 60 };
      rateLimit(req, opts);
      try {
        rateLimit(req, opts);
      } catch {
        // expected rejection
      }
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[METRIC] auth.rateLimit.hit")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("different IPs are rate-limited independently", () => {
    resetAllBuckets();
    const opts = { endpoint: "login-ip-t16", capacity: 1, refillPerMin: 60 };
    rateLimit(makeReq("10.0.0.3"), opts);
    let caught: unknown;
    try {
      rateLimit(makeReq("10.0.0.3"), opts);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(() => rateLimit(makeReq("10.0.0.4"), opts)).not.toThrow();
  });

  test("identityKey isolates buckets between two identities on same IP", () => {
    resetAllBuckets();
    const req = makeReq("10.0.0.5");
    const opts = { endpoint: "round-register", capacity: 1, refillPerMin: 0, identityKey: "pilot-a" };
    const optsB = { ...opts, identityKey: "pilot-b" };
    rateLimit(req, opts);
    rateLimit(req, optsB);
    expect(() => rateLimit(req, opts)).toThrow();
    expect(() => rateLimit(req, optsB)).toThrow();
  });

  test("absent identityKey preserves IP-keyed behavior", () => {
    resetAllBuckets();
    const opts = { endpoint: "round-register", capacity: 1, refillPerMin: 0 };
    rateLimit(makeReq("10.0.0.6"), opts);
    expect(() => rateLimit(makeReq("10.0.0.6"), opts)).toThrow();
    expect(() => rateLimit(makeReq("10.0.0.7"), opts)).not.toThrow();
  });
});

// ─── mutationRateLimit() ─────────────────────────────────────────────────────

function makeCaller(userId: string = randomUUID()): CallerIdentity {
  return {
    userId,
    email: `${userId}@example.test`,
    roles: ["Admin"],
    pilotId: null,
    clubId: null,
  };
}

describe("mutationRateLimit", () => {
  test("standard tier: 30 calls pass, 31st throws HttpError 429 RATE_LIMITED", async () => {
    resetAllBuckets();
    const req = makeReq("10.0.1.1");
    const caller = makeCaller();
    for (let i = 0; i < 30; i++) {
      await mutationRateLimit(req, caller, "standard-boundary", "standard");
    }
    let caught: unknown;
    try {
      await mutationRateLimit(req, caller, "standard-boundary", "standard");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(429);
    expect((caught as HttpError).code).toBe("RATE_LIMITED");
  });

  test("heavy tier: 5 calls pass, 6th throws HttpError 429 RATE_LIMITED", async () => {
    resetAllBuckets();
    const req = makeReq("10.0.1.2");
    const caller = makeCaller();
    for (let i = 0; i < 5; i++) {
      await mutationRateLimit(req, caller, "heavy-boundary", "heavy");
    }
    let caught: unknown;
    try {
      await mutationRateLimit(req, caller, "heavy-boundary", "heavy");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(429);
    expect((caught as HttpError).code).toBe("RATE_LIMITED");
  });

  test("flights tier: 60 calls pass, 61st throws HttpError 429 RATE_LIMITED", async () => {
    resetAllBuckets();
    const req = makeReq("10.0.1.3");
    const caller = makeCaller();
    for (let i = 0; i < 60; i++) {
      await mutationRateLimit(req, caller, "flights-boundary", "flights");
    }
    let caught: unknown;
    try {
      await mutationRateLimit(req, caller, "flights-boundary", "flights");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(429);
    expect((caught as HttpError).code).toBe("RATE_LIMITED");
  });

  test("buckets are keyed by caller.userId, not by IP", async () => {
    resetAllBuckets();
    const req = makeReq("10.0.1.4");
    const callerA = makeCaller();
    const callerB = makeCaller();
    for (let i = 0; i < 5; i++) {
      await mutationRateLimit(req, callerA, "heavy-isolation", "heavy");
    }
    await expect(
      mutationRateLimit(req, callerA, "heavy-isolation", "heavy")
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      mutationRateLimit(req, callerB, "heavy-isolation", "heavy")
    ).resolves.toBeUndefined();
  });
});

// ─── Account lockout helpers ──────────────────────────────────────────────────

describe("account lockout", () => {
  test("5 failed logins -> checkAccountLockout throws HttpError 423 ACCOUNT_LOCKED", async () => {
    const userId = randomUUID();
    await seedAuthBlob(userId);

    for (let i = 0; i < 5; i++) {
      await recordLoginFailure(userId);
    }

    let caught: unknown;
    try {
      await checkAccountLockout(userId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(423);
    expect((caught as HttpError).code).toBe("ACCOUNT_LOCKED");
  });

  test("successful login resets failedAttempts to 0", async () => {
    const userId = randomUUID();
    await seedAuthBlob(userId);

    await recordLoginFailure(userId);
    await recordLoginFailure(userId);
    await recordLoginFailure(userId);

    await recordLoginSuccess(userId);

    const cred = await readBlob<{ failedAttempts: string[]; lockedUntil: string | null }>(
      getPrivateBlobClient(`auth/${userId}.json`)
    );
    expect(cred.failedAttempts).toEqual([]);
    expect(cred.lockedUntil).toBeNull();
  });

  test("[METRIC] auth.lockout.triggered emitted when 5 failures trigger lockout", async () => {
    const userId = randomUUID();
    await seedAuthBlob(userId);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) {
        await recordLoginFailure(userId);
      }
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[METRIC] auth.lockout.triggered")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("lockout auto-expires: checkAccountLockout passes after clock advances past lockedUntil", async () => {
    const userId = randomUUID();
    const baseTime = new Date("2025-06-01T12:00:00Z");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(baseTime);

    try {
      await seedAuthBlob(userId);

      for (let i = 0; i < 5; i++) {
        await recordLoginFailure(userId);
      }

      await expect(checkAccountLockout(userId)).rejects.toBeInstanceOf(HttpError);

      vi.setSystemTime(new Date(baseTime.getTime() + 16 * 60_000));

      await expect(checkAccountLockout(userId)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
