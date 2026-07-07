import { describe, expect, it } from "vitest";
import type { PilotSlot, Round, RoundBrief, Signature } from "@bccweb/types";
import { materializeSignToFly } from "../reflect.js";

describe("materializeSignToFly", () => {
  it("sets slots from current, stale, absent, and override signatures", () => {
    // Given: a current brief and mixed slot/signature states.
    const round = makeRound([
      makeSlot({ placeInTeam: 1, signToFly: false }),
      makeSlot({ placeInTeam: 2, signToFly: true }),
      makeSlot({ placeInTeam: 3, signToFly: true }),
      makeSlot({ placeInTeam: 4, signToFly: false }),
    ]);
    const brief = makeBrief({ version: 2 });
    const signatures = [
      makeSignature({ teamId: "team-1", place: 1, briefVersion: 2 }),
      makeSignature({ teamId: "team-1", place: 2, briefVersion: 1 }),
      makeSignature({
        teamId: "team-1",
        place: 4,
        briefVersion: 2,
        source: "coord-override",
      }),
    ];

    // When: the materialized flags are reflected onto the round.
    const changed = materializeSignToFly(round, brief, signatures);

    // Then: each slot matches only the latest signature's brief version.
    expect(changed).toBe(true);
    expect(slotFlags(round)).toEqual([true, false, false, true]);
  });

  it("uses the max non-null briefVersion and ignores legacy null versions", () => {
    // Given: legacy/null and older entries exist before a current signature.
    const round = makeRound([
      makeSlot({ placeInTeam: 1, signToFly: false }),
      makeSlot({ placeInTeam: 2, signToFly: true }),
    ]);
    const brief = makeBrief({ version: 3 });
    const signatures = [
      makeSignature({ teamId: "team-1", place: 1, briefVersion: null }),
      makeSignature({ teamId: "team-1", place: 1, briefVersion: 1 }),
      makeSignature({ teamId: "team-1", place: 1, briefVersion: 3 }),
      makeSignature({ teamId: "team-1", place: 2, briefVersion: null }),
    ];

    // When: the latest version map is materialized.
    const changed = materializeSignToFly(round, brief, signatures);

    // Then: max non-null version wins, while null-only signatures behave absent.
    expect(changed).toBe(true);
    expect(slotFlags(round)).toEqual([true, false]);
  });

  it("defaults an undefined brief version to one", () => {
    // Given: a brief without a stored version and a version-one signature.
    const round = makeRound([makeSlot({ placeInTeam: 1, signToFly: false })]);
    const brief = makeBrief();
    const signatures = [makeSignature({ teamId: "team-1", place: 1, briefVersion: 1 })];

    // When: the brief version is omitted.
    const changed = materializeSignToFly(round, brief, signatures);

    // Then: version one is treated as current.
    expect(changed).toBe(true);
    expect(slotFlags(round)).toEqual([true]);
  });

  it("clears every slot when the signature list is empty", () => {
    // Given: slots currently marked as signed but no signatures are present.
    const round = makeRound([
      makeSlot({ placeInTeam: 1, signToFly: true }),
      makeSlot({ placeInTeam: 2, signToFly: true }),
    ]);
    const brief = makeBrief({ version: 1 });

    // When: no signature can support any slot.
    const changed = materializeSignToFly(round, brief, []);

    // Then: all flags are materialized to false.
    expect(changed).toBe(true);
    expect(slotFlags(round)).toEqual([false, false]);
  });

  it("returns false when all slots already match the signature materialization", () => {
    // Given: slots already match current, stale, and absent signature outcomes.
    const round = makeRound([
      makeSlot({ placeInTeam: 1, signToFly: true }),
      makeSlot({ placeInTeam: 2, signToFly: false }),
      makeSlot({ placeInTeam: 3, signToFly: false }),
    ]);
    const brief = makeBrief({ version: 2 });
    const signatures = [
      makeSignature({ teamId: "team-1", place: 1, briefVersion: 2 }),
      makeSignature({ teamId: "team-1", place: 2, briefVersion: 1 }),
    ];

    // When: materialization is repeated.
    const changed = materializeSignToFly(round, brief, signatures);

    // Then: no mutation is reported and values stay the same.
    expect(changed).toBe(false);
    expect(slotFlags(round)).toEqual([true, false, false]);
  });
});

function makeRound(pilots: PilotSlot[]): Round {
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
