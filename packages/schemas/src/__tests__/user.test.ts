import { describe, expect, test } from "vitest";

import { AuthCredentialSchema, normalizeRoles, UserSchema } from "../user.js";

const validUser = {
  id: "user-1",
  email: "pilot@example.test",
  roles: ["Admin", "Pilot"],
  pilotId: "pilot-1",
  clubId: "club-1",
  createdAt: "2026-06-11T00:00:00.000Z",
  acceptedTsCsAt: "2026-06-11T00:01:00.000Z",
  acceptedTsCsIp: "203.0.113.10",
  acceptedTsCsVersion: 4,
} as const;

const validCredential = {
  passwordHash: "$2b$04$012345678901234567890uOoxdShBvmFUZB37V26fdkQypN9UEXXu",
  emailVerified: true,
  createdAt: "2026-06-11T00:00:00.000Z",
} as const;

describe("UserSchema", () => {
  test("round-trips a valid User", () => {
    expect(UserSchema.parse(validUser)).toEqual(validUser);
  });

  test("fails when id identity field is missing", () => {
    const { id: _id, ...withoutId } = validUser;

    expect(UserSchema.safeParse(withoutId).success).toBe(false);
  });

  test("fails when email identity field is missing", () => {
    const { email: _email, ...withoutEmail } = validUser;

    expect(UserSchema.safeParse(withoutEmail).success).toBe(false);
  });

  test("strips unknown User keys", () => {
    const parsed = UserSchema.parse({ ...validUser, junk: 1 });

    expect(parsed).not.toHaveProperty("junk");
  });

  test("maps legacy role aliases to canonical roles", () => {
    const parsed = UserSchema.parse({
      ...validUser,
      roles: ["administrator", "rounds_coord", "pilot"],
    });

    expect(parsed.roles).toEqual(["Admin", "RoundsCoord", "Pilot"]);
  });

  test("deduplicates normalized roles", () => {
    expect(normalizeRoles(["Admin", "administrator", "Pilot"])).toEqual([
      "Admin",
      "Pilot",
    ]);
  });
});

describe("AuthCredentialSchema", () => {
  test("round-trips a valid AuthCredential", () => {
    expect(AuthCredentialSchema.parse(validCredential)).toEqual(validCredential);
  });

  test("preserves runtime lockout fields", () => {
    const credential = {
      ...validCredential,
      failedAttempts: ["2026-06-11T23:58:00.000Z", "2026-06-11T23:59:00.000Z"],
      lockedUntil: "2026-06-12T00:00:00Z",
    };

    expect(AuthCredentialSchema.parse(credential)).toEqual(credential);
  });

  test("preserves failedAttemptCount compatibility lockout field", () => {
    const credential = {
      ...validCredential,
      failedAttemptCount: 3,
      lockedUntil: "2026-06-12T00:00:00Z",
    };

    const parsed = AuthCredentialSchema.parse(credential);

    expect(parsed.failedAttemptCount).toBe(3);
    expect(parsed.lockedUntil).toBe(credential.lockedUntil);
  });

  test("strips unknown credential keys", () => {
    const parsed = AuthCredentialSchema.parse({ ...validCredential, junk: 1 });

    expect(parsed).not.toHaveProperty("junk");
  });

  test("accepts both bcrypt $2a$ and $2b$ hashes without over-constraining format", () => {
    const twoA = AuthCredentialSchema.parse({
      ...validCredential,
      passwordHash: "$2a$04$012345678901234567890uOoxdShBvmFUZB37V26fdkQypN9UEXXu",
    });
    const twoB = AuthCredentialSchema.parse({
      ...validCredential,
      passwordHash: "$2b$04$012345678901234567890uOoxdShBvmFUZB37V26fdkQypN9UEXXu",
    });

    expect(twoA.passwordHash.startsWith("$2a$")).toBe(true);
    expect(twoB.passwordHash.startsWith("$2b$")).toBe(true);
  });
});
