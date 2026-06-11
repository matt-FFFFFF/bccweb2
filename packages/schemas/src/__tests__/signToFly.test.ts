import { describe, expect, test } from "vitest";

import {
  ActiveWordingPointerSchema,
  SignatureLedgerSchema,
  SignToFlyWordingSchema,
} from "../signToFly.js";

const validWording = {
  version: 2,
  hash: "wording-hash",
  html: "<p>Sign to fly</p>",
  plainText: "Sign to fly",
  createdAt: "2026-06-11T00:00:00Z",
  createdBy: "admin-1",
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

  test.each(["hash", "createdAt", "createdBy"] as const)(
    "fails when required wording field %s is missing",
    (field) => {
      const incomplete = { ...validWording };
      delete incomplete[field];

      expect(SignToFlyWordingSchema.safeParse(incomplete).success).toBe(false);
    },
  );

  test("preserves optional supersession metadata", () => {
    expect(
      SignToFlyWordingSchema.parse({
        ...validWording,
        supersededAt: "2026-06-12T00:00:00Z",
        supersededBy: 3,
      }),
    ).toEqual({
      ...validWording,
      supersededAt: "2026-06-12T00:00:00Z",
      supersededBy: 3,
    });
  });

  test("strips unknown wording metadata", () => {
    expect(
      SignToFlyWordingSchema.parse({
        ...validWording,
        publishedAt: "legacy-field",
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
  test("round-trips a valid signature ledger entry", () => {
    expect(SignatureLedgerSchema.parse(validSignature)).toEqual(validSignature);
  });

  test.each([
    "id",
    "roundId",
    "teamId",
    "place",
    "pilotId",
    "userId",
    "signedAt",
    "briefVersion",
    "briefHash",
    "wordingVersion",
    "wordingHash",
    "ip",
    "userAgent",
    "source",
  ] as const)("hard-fails when required signature field %s is missing", (field) => {
    const incomplete = { ...validSignature };
    delete incomplete[field];

    expect(SignatureLedgerSchema.safeParse(incomplete).success).toBe(false);
  });

  test("preserves nullable signature fields", () => {
    const parsed = SignatureLedgerSchema.parse({
      ...validSignature,
      signedAt: null,
      briefVersion: null,
      briefHash: null,
      wordingVersion: null,
      wordingHash: null,
      ip: null,
      userAgent: null,
    });

    expect(parsed.signedAt).toBeNull();
    expect(parsed.briefVersion).toBeNull();
    expect(parsed.briefHash).toBeNull();
    expect(parsed.wordingVersion).toBeNull();
    expect(parsed.wordingHash).toBeNull();
    expect(parsed.ip).toBeNull();
    expect(parsed.userAgent).toBeNull();
  });

  test("rejects corrupt required signature metadata", () => {
    expect(
      SignatureLedgerSchema.safeParse({
        ...validSignature,
        ip: 123,
      }).success,
    ).toBe(false);
  });

  test("heals corrupt optional signature metadata without changing identity", () => {
    const parsed = SignatureLedgerSchema.parse({
      ...validSignature,
      overrideReason: 123,
      legacyId: "not-a-number",
      obsolete: true,
    });

    expect(parsed.pilotId).toBe("pilot-1");
    expect(parsed.roundId).toBe("round-1");
    expect(parsed.wordingVersion).toBe(2);
    expect(parsed.overrideReason).toBeUndefined();
    expect(parsed.legacyId).toBeUndefined();
    expect(parsed).not.toHaveProperty("obsolete");
  });
});
