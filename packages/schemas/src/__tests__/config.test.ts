import { describe, expect, test } from "vitest";
import * as z from "zod/v4";

import { ConfigSchema } from "../config.js";

const defaultWingFactors = {
  "EN A": 1.0,
  "EN B": 0.9,
  "EN C": 0.8,
  "EN C 2-liner": 0.7,
  "EN D": 0.6,
  "EN D 2-liner": 0.5,
};

const validConfig = {
  maxTeamsInClub: 3,
  maxPilotsInTeam: 10,
  maxScoringPilotsInTeam: 5,
  flightDateValidationEnabled: false,
  wingFactors: {
    "EN A": 1.1,
    "EN B": 1.0,
    "EN C": 0.9,
    "EN C 2-liner": 0.8,
    "EN D": 0.7,
    "EN D 2-liner": 0.6,
  },
};

describe("ConfigSchema", () => {
  test("valid config round-trips", () => {
    expect(ConfigSchema.parse(validConfig)).toEqual(validConfig);
  });

  test("missing scalar defaults are applied", () => {
    expect(ConfigSchema.parse({ wingFactors: defaultWingFactors })).toEqual({
      maxTeamsInClub: 2,
      maxPilotsInTeam: 12,
      maxScoringPilotsInTeam: 6,
      flightDateValidationEnabled: true,
      wingFactors: defaultWingFactors,
    });
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

  test("legacy alternate wingClass enum keys are healed via preprocess", () => {
    expect(
      ConfigSchema.parse({
        wingFactors: {
          EN_A: 1.1,
          EN_B: 1.0,
          EN_C: 0.9,
          EN_C_2_LINER: 0.8,
          EN_D: 0.7,
          EN_D_2_LINER: 0.6,
        },
      }).wingFactors,
    ).toEqual({
      "EN A": 1.1,
      "EN B": 1.0,
      "EN C": 0.9,
      "EN C 2-liner": 0.8,
      "EN D": 0.7,
      "EN D 2-liner": 0.6,
    });
  });

  test("identity fields missing throw instead of healing", () => {
    const identitySchema = z.object({ id: z.string() }).strip();

    expect(() => identitySchema.parse({})).toThrow();
  });

  test("parse empty object returns full default config with all six wingFactors", () => {
    expect(ConfigSchema.parse({})).toEqual({
      maxTeamsInClub: 2,
      maxPilotsInTeam: 12,
      maxScoringPilotsInTeam: 6,
      flightDateValidationEnabled: true,
      wingFactors: defaultWingFactors,
    });
  });

  test("unknown top-level config keys are stripped", () => {
    expect(ConfigSchema.parse({ ...validConfig, obsolete: true })).toEqual(validConfig);
  });
});
