import { randomUUID } from "node:crypto";
import { BriefSchema, RoundSchema } from "@bccweb/schemas";
import type { PilotSlot, Round, RoundBrief, Signature } from "@bccweb/types";
import { describe, expect, it, vi } from "vitest";

const signatureListOrderProbe = vi.hoisted((): {
  roundId: string | null;
  roundPath: string | null;
  leaseEntered: boolean;
  listSawLeaseEntered: boolean;
} => ({
  roundId: null,
  roundPath: null,
  leaseEntered: false,
  listSawLeaseEntered: false,
}));

vi.mock("../../blob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../blob.js")>();

  return {
    ...actual,
    withPrivateLeaseRetry: async <T>(path: string, fn: (leaseId: string) => Promise<T>): Promise<T> =>
      actual.withPrivateLeaseRetry(path, async (leaseId) => {
        if (signatureListOrderProbe.roundPath === path) {
          signatureListOrderProbe.leaseEntered = true;
        }

        return fn(leaseId);
      }),
  };
});

vi.mock("../ledger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ledger.js")>();

  return {
    ...actual,
    listSignaturesForRound: async (roundId: string): Promise<Signature[]> => {
      if (signatureListOrderProbe.roundId === roundId) {
        signatureListOrderProbe.listSawLeaseEntered = signatureListOrderProbe.leaseEntered;
      }

      return actual.listSignaturesForRound(roundId);
    },
  };
});

const { getPrivateBlobClient } = await import("../../blob.js");
const { readJson, writePrivateJson } = await import("../../blobJson.js");
const { reflectRoundSignToFly } = await import("../reflect.js");
const { writeSignature } = await import("../ledger.js");

describe("reflectRoundSignToFly lease ordering", () => {
  it("lists signatures after entering the round lease so stale snapshots cannot clobber newer materialization", async () => {
    // Given: a BriefComplete round, current brief, and matching signature blob.
    const roundId = randomUUID();
    await seedRound(makeRound([makeSlot({ signToFly: false })], { id: roundId }));
    await seedBrief(makeBrief({ roundId, version: 1 }));
    await writeSignature(makeSignature({ roundId, briefVersion: 1 }));
    signatureListOrderProbe.roundId = roundId;
    signatureListOrderProbe.roundPath = `rounds/${roundId}.json`;

    try {
      // When: the reflector replays the ledger for the round.
      await reflectRoundSignToFly(roundId);

      // Then: the ledger list ran inside the round lease and materialized the flag.
      expect(signatureListOrderProbe.listSawLeaseEntered).toBe(true);
      expect(slotFlags(await readRound(roundId))).toEqual([true]);
    } finally {
      signatureListOrderProbe.roundId = null;
      signatureListOrderProbe.roundPath = null;
      signatureListOrderProbe.leaseEntered = false;
      signatureListOrderProbe.listSawLeaseEntered = false;
    }
  });
});

function makeRound(pilots: PilotSlot[], overrides: Partial<Round> = {}): Round {
  return {
    id: "round-1",
    date: "2026-07-07",
    status: "BriefComplete",
    isLocked: true,
    maxTeams: 1,
    minimumScore: 0,
    site: { id: "site-1", name: "Test Site" },
    season: { year: 2026 },
    teams: [
      {
        id: "team-1",
        teamName: "Team One",
        club: { id: "club-1", name: "Club One" },
        score: 0,
        pilots,
      },
    ],
    ...overrides,
  };
}

function makeSlot(overrides: Partial<PilotSlot>): PilotSlot {
  return {
    placeInTeam: 1,
    isScoring: true,
    status: "Filled",
    accountedFor: false,
    signToFly: false,
    noScore: false,
    pilotPoints: 0,
    pilotId: "pilot-1",
    snapshot: null,
    flight: null,
    ...overrides,
  };
}

function makeBrief(overrides: Partial<RoundBrief & { version?: number }> = {}): RoundBrief & { version?: number } {
  return {
    roundId: "round-1",
    generatedAt: "2026-07-07T00:00:00.000Z",
    date: "2026-07-07",
    siteName: "Test Site",
    teams: [],
    ...overrides,
  };
}

function makeSignature(overrides: Partial<Signature>): Signature {
  return {
    id: "signature-1",
    roundId: "round-1",
    teamId: "team-1",
    place: 1,
    pilotId: "pilot-1",
    userId: "user-1",
    signedAt: "2026-07-07T00:00:00.000Z",
    briefVersion: 1,
    briefHash: "brief-hash",
    wordingVersion: 1,
    wordingHash: "wording-hash",
    ip: "203.0.113.1",
    userAgent: "vitest",
    source: "pilot-self",
    ...overrides,
  };
}

function slotFlags(round: Round): boolean[] {
  return round.teams.flatMap((team) => team.pilots.map((slot) => slot.signToFly));
}

async function seedRound(round: Round): Promise<void> {
  await writePrivateJson(`rounds/${round.id}.json`, RoundSchema, round);
}

async function seedBrief(brief: RoundBrief & { version?: number }): Promise<void> {
  await writePrivateJson(`round-briefs/${brief.roundId}.json`, BriefSchema, brief);
}

async function readRound(roundId: string): Promise<Round> {
  const path = `rounds/${roundId}.json`;
  return readJson(getPrivateBlobClient(path), RoundSchema, path);
}
