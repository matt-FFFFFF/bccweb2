import { describe, expect, test } from "vitest";

import {
  ActiveWordingPointerSchema,
  SignatureLedgerSchema,
  SignToFlyWordingSchema,
} from "../signToFly.js";

const validWording = {
  version: 2,
  html: "<p>Sign to fly</p>",
  plainText: "Sign to fly",
  publishedAt: "2026-06-11T00:00:00Z",
  publishedBy: "admin-1",
} as const;

const validSignature = {
  id: "signature-1",
  roundId: "round-1",
  teamId: "team-1",
  place: 1,
  pilotId: "pilot-1",
  userId: "user-1",
  signedAt: "2026-06-11T00:00:00Z",
  briefVersion: 1,
  briefHash: "brief-hash",
  wordingVersion: 2,
  wordingHash: "wording-hash",
  ip: "203.0.113.1",
  userAgent: "vitest",
  source: "pilot-self",
} as const;

describe("SignToFlyWordingSchema", () => {
  test("round-trips a valid wording version blob without sanitising html", () => {
    expect(SignToFlyWordingSchema.parse(validWording)).toEqual(validWording);
  });

  test("fails when version identity field is missing", () => {
    const { version: _version, ...withoutVersion } = validWording;

    expect(SignToFlyWordingSchema.safeParse(withoutVersion).success).toBe(false);
  });

  test("strips unknown wording metadata", () => {
    expect(
      SignToFlyWordingSchema.parse({
        ...validWording,
        hash: "stored-but-not-schema-identity",
      }),
    ).toEqual(validWording);
  });
});

describe("ActiveWordingPointerSchema", () => {
  test("rejects activeVersion zero", () => {
    expect(ActiveWordingPointerSchema.safeParse({ activeVersion: 0 }).success).toBe(false);
  });

  test("accepts activeVersion one", () => {
    expect(ActiveWordingPointerSchema.safeParse({ activeVersion: 1 }).success).toBe(true);
  });
});

describe("SignatureLedgerSchema", () => {
  test("accepts the per-pilot signature identity triple", () => {
    expect(
      SignatureLedgerSchema.parse({
        pilotId: "p1",
        roundId: "r1",
        wordingVersion: 2,
        signedAt: "2026-06-11T00:00:00Z",
      }),
    ).toEqual({
      pilotId: "p1",
      roundId: "r1",
      wordingVersion: 2,
      signedAt: "2026-06-11T00:00:00Z",
    });
  });

  test("hard-fails when pilotId identity field is missing", () => {
    const { pilotId: _pilotId, ...withoutPilotId } = validSignature;

    expect(() => SignatureLedgerSchema.parse(withoutPilotId)).toThrow(/pilotId/);
  });

  test("heals corrupt optional signature metadata without changing identity", () => {
    const parsed = SignatureLedgerSchema.parse({
      ...validSignature,
      ip: 123,
      userAgent: false,
      source: "legacy-alias",
      obsolete: true,
    });

    expect(parsed.pilotId).toBe("pilot-1");
    expect(parsed.roundId).toBe("round-1");
    expect(parsed.wordingVersion).toBe(2);
    expect(parsed.ip).toBeUndefined();
    expect(parsed.userAgent).toBeUndefined();
    expect(parsed.source).toBeUndefined();
    expect(parsed).not.toHaveProperty("obsolete");
  });
});
