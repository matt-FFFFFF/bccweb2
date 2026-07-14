// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";
import * as z from "zod/v4";

import { ConfigPatchSchema, ConfigSchema } from "../config.js";

// ─── Legacy default tables (source-of-truth provenance in comments) ──────────

const defaultWingFactors = {
  "EN A": 1.0,
  "EN B": 0.9,
  "EN C": 0.8,
  "EN C 2-liner": 0.7,
  "EN D": 0.6,
  "EN D 2-liner": 0.5,
}; // Web.config:104-109

const defaultPilotFactors = {
  "Club Pilot": 1,
  Pilot: 1,
  "Advanced Pilot": 0.9,
}; // BaseController.cs:1661-1678 (GetPilotFactor)

const defaultClubsAttendingFactors = {
  fewerThanThreeClubs: 0.5,
  exactlyThreeClubs: 0.75,
  moreThanThreeClubs: 1,
}; // BaseController.cs:2254-2275 (GetClubsAttendingFactor)

const defaultMinDistanceFactors = {
  oneFlight: 0.2,
  twoFlights: 0.4,
  threeFlights: 0.6,
  fourFlights: 0.8,
  fiveOrMoreFlights: 1,
}; // BaseController.cs:2277-2309 (GetMinDistanceFactor)

const fullDefaultConfig = {
  maxTeamsInClub: 2, // Web.config:97
  maxPilotsInTeam: 9, // Web.config:99 (was 12 — legacy value is 9)
  maxScoringPilotsInTeam: 6, // Web.config:98
  maxPilotScoresCountedPerTeam: 4, // BaseController.cs:2359
  leagueRoundScoresCounted: 6, // LeagueTeamSeasonViewModel.cs:27
  flightDateValidationEnabled: true,
  flightSignatureValidationEnabled: false,
  roundBriefRecipients: [],
  wingFactors: defaultWingFactors,
  taskMaxPoints: 1000, // BaseController.cs:2461 (int taskMaxPoints = 1000)
  pilotFactors: defaultPilotFactors,
  clubsAttendingFactors: defaultClubsAttendingFactors,
  minDistanceFactors: defaultMinDistanceFactors,
};

// A fully-specified config with every value distinct from its default, so a
// clean round-trip proves the schema never overwrites a provided value.
const validConfig = {
  maxTeamsInClub: 3,
  maxPilotsInTeam: 10,
  maxScoringPilotsInTeam: 5,
  maxPilotScoresCountedPerTeam: 3,
  leagueRoundScoresCounted: 5,
  flightDateValidationEnabled: false,
  flightSignatureValidationEnabled: true,
  roundBriefRecipients: [],
  wingFactors: {
    "EN A": 1.1,
    "EN B": 1.0,
    "EN C": 0.9,
    "EN C 2-liner": 0.8,
    "EN D": 0.7,
    "EN D 2-liner": 0.6,
  },
  taskMaxPoints: 900,
  pilotFactors: {
    "Club Pilot": 0.95,
    Pilot: 0.9,
    "Advanced Pilot": 0.85,
  },
  clubsAttendingFactors: {
    fewerThanThreeClubs: 0.4,
    exactlyThreeClubs: 0.7,
    moreThanThreeClubs: 0.95,
  },
  minDistanceFactors: {
    oneFlight: 0.1,
    twoFlights: 0.3,
    threeFlights: 0.5,
    fourFlights: 0.7,
    fiveOrMoreFlights: 0.95,
  },
};

describe("ConfigSchema", () => {
  test("valid config round-trips unchanged", () => {
    expect(ConfigSchema.parse(validConfig)).toEqual(validConfig);
  });

  test("missing fields are filled from a partial input", () => {
    // Only wingFactors supplied — every other field (scalars + nested factor
    // maps) must be hydrated from its legacy default.
    expect(ConfigSchema.parse({ wingFactors: defaultWingFactors })).toEqual(
      fullDefaultConfig,
    );
  });

  test("parse empty object returns the full legacy-default config", () => {
    expect(ConfigSchema.parse({})).toEqual(fullDefaultConfig);
  });

  test("maxPilotsInTeam default is 9 (changed from legacy-drifted 12)", () => {
    // Legacy Web.config:99 MaxPilotsInTeam=9 — the prior schema shipped 12.
    expect(ConfigSchema.parse({}).maxPilotsInTeam).toBe(9);
  });

  test("new scalar count + taskMaxPoints defaults match legacy", () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.maxTeamsInClub).toBe(2); // Web.config:97
    expect(parsed.maxScoringPilotsInTeam).toBe(6); // Web.config:98
    expect(parsed.maxPilotScoresCountedPerTeam).toBe(4); // BaseController.cs:2359
    expect(parsed.leagueRoundScoresCounted).toBe(6); // LeagueTeamSeasonViewModel.cs:27
    expect(parsed.taskMaxPoints).toBe(1000); // BaseController.cs:2461
  });

  test("factor tables default to legacy values", () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.pilotFactors).toEqual(defaultPilotFactors);
    expect(parsed.clubsAttendingFactors).toEqual(defaultClubsAttendingFactors);
    expect(parsed.minDistanceFactors).toEqual(defaultMinDistanceFactors);
  });

  test("round brief recipients default to an empty array", () => {
    expect(ConfigSchema.parse({}).roundBriefRecipients).toEqual([]);
  });

  test("flight signature validation defaults to false when absent", () => {
    expect(ConfigSchema.parse({}).flightSignatureValidationEnabled).toBe(false);
  });

  test("round brief recipients heal by dropping invalid entries", () => {
    expect(
      ConfigSchema.parse({ roundBriefRecipients: ["ok@x.com", "bad", 5] })
        .roundBriefRecipients,
    ).toEqual(["ok@x.com"]);
  });

  test("unknown wingFactors key is rejected in strict mode", () => {
    const result = ConfigSchema.safeParse({
      wingFactors: {
        ...defaultWingFactors,
        BogusClass: 99,
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["wingFactors"]);
    }
  });

  test("legacy alternate wingClass enum keys are rejected in strict mode", () => {
    const result = ConfigSchema.safeParse({
      wingFactors: {
        EN_A: 1.1,
        EN_B: 1.0,
        EN_C: 0.9,
        EN_C_2_LINER: 0.8,
        EN_D: 0.7,
        EN_D_2_LINER: 0.6,
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["wingFactors"]);
    }
  });

  test("unknown pilotFactors key is rejected by the nested .strict()", () => {
    const result = ConfigSchema.safeParse({
      pilotFactors: { ...defaultPilotFactors, Tandem: 0.5 },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["pilotFactors"]);
    }
  });

  test("a corrupt nested factor value heals to its legacy default (observe mode)", () => {
    // oneFlight is garbage → heals to legacy 0.2; the provided sibling 0.99 is
    // preserved, proving this is a heal, not a whole-object default reset.
    const parsed = ConfigSchema.parse({
      minDistanceFactors: {
        oneFlight: "corrupt",
        twoFlights: 0.99,
        threeFlights: 0.6,
        fourFlights: 0.8,
        fiveOrMoreFlights: 1,
      },
    });

    expect(parsed.minDistanceFactors.oneFlight).toBe(0.2); // BaseController.cs:2289
    expect(parsed.minDistanceFactors.twoFlights).toBe(0.99); // provided value kept
  });

  test("lenient full schema hydrates sibling factors from a partial map", () => {
    // Contrast with ConfigPatchSchema below: the FULL schema fills the sibling
    // pilot factors from defaults, which is why a strict patch schema is needed.
    const full = ConfigSchema.parse({ pilotFactors: { Pilot: 1.1 } });
    expect(full.pilotFactors).toEqual({
      "Club Pilot": 1,
      Pilot: 1.1,
      "Advanced Pilot": 0.9,
    });
  });

  test("identity fields missing throw instead of healing", () => {
    const identitySchema = z.object({ id: z.string() }).strip();

    expect(() => identitySchema.parse({})).toThrow();
  });

  test("unknown top-level config keys are stripped", () => {
    expect(ConfigSchema.parse({ ...validConfig, obsolete: true })).toEqual(
      validConfig,
    );
  });
});

describe("ConfigPatchSchema", () => {
  test("accepts a flight signature validation toggle", () => {
    expect(ConfigPatchSchema.parse({ flightSignatureValidationEnabled: true })).toEqual({
      flightSignatureValidationEnabled: true,
    });
  });

  test("rejects invalid round brief recipients", () => {
    expect(
      ConfigPatchSchema.safeParse({ roundBriefRecipients: ["nope"] }).success,
    ).toBe(false);
  });

  test("accepts an empty patch without injecting round brief recipients", () => {
    expect(ConfigPatchSchema.safeParse({}).success).toBe(true);
  });

  test("accepts valid round brief recipients", () => {
    expect(
      ConfigPatchSchema.safeParse({ roundBriefRecipients: ["a@b.com"] }).success,
    ).toBe(true);
  });

  test("a single nested factor key yields exactly that key — no siblings, no top-level defaults", () => {
    const patch = ConfigPatchSchema.parse({ pilotFactors: { Pilot: 1.1 } });

    // Oracle O3: deep-equals exactly the input; nothing hydrated anywhere.
    expect(patch).toEqual({ pilotFactors: { Pilot: 1.1 } });
    expect(Object.keys(patch)).toEqual(["pilotFactors"]);
    expect(Object.keys(patch.pilotFactors ?? {})).toEqual(["Pilot"]);
    expect(patch.pilotFactors).not.toHaveProperty("Club Pilot");
    expect(patch.pilotFactors).not.toHaveProperty("Advanced Pilot");
  });

  test("empty patch injects no defaults", () => {
    expect(ConfigPatchSchema.parse({})).toEqual({});
  });

  test("a single scalar patch field passes through alone", () => {
    const patch = ConfigPatchSchema.parse({ maxPilotsInTeam: 7 });
    expect(patch).toEqual({ maxPilotsInTeam: 7 });
  });

  test("rejects an unknown nested factor key via .strict()", () => {
    const result = ConfigPatchSchema.safeParse({ pilotFactors: { Bogus: 1 } });
    expect(result.success).toBe(false);
  });
});
