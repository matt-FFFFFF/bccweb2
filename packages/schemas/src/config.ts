import type { Config } from "@bccweb/types";
import * as z from "zod/v4";

import { healed, normalizeEnum } from "./helpers.js";

const wingClassValues = [
  "EN A",
  "EN B",
  "EN C",
  "EN C 2-liner",
  "EN D",
  "EN D 2-liner",
] as const;

const wingClassAliases = {
  EN_A: "EN A",
  EN_B: "EN B",
  EN_C: "EN C",
  EN_C_2_LINER: "EN C 2-liner",
  EN_C_2_LINER_LOWER: "EN C 2-liner",
  EN_D: "EN D",
  EN_D_2_LINER: "EN D 2-liner",
  EN_D_2_LINER_LOWER: "EN D 2-liner",
  ENC2Liner: "EN C 2-liner",
  END2Liner: "EN D 2-liner",
} as const satisfies Record<string, (typeof wingClassValues)[number]>;

const WingFactorSchema = healed(z.number(), 1);

const WingFactorsSchema = z
  .object({
    "EN A": WingFactorSchema.default(1.0),
    "EN B": WingFactorSchema.default(0.9),
    "EN C": WingFactorSchema.default(0.8),
    "EN C 2-liner": WingFactorSchema.default(0.7),
    "EN D": WingFactorSchema.default(0.6),
    "EN D 2-liner": WingFactorSchema.default(0.5),
  })
  .strict();

export const ConfigSchema = z
  .object({
    maxTeamsInClub: healed(z.number(), 2).default(2),
    maxPilotsInTeam: healed(z.number(), 12).default(12),
    maxScoringPilotsInTeam: healed(z.number(), 6).default(6),
    flightDateValidationEnabled: healed(z.boolean(), true).default(true),
    wingFactors: z
      .preprocess((raw) => {
        if (raw === undefined) {
          return undefined;
        }

        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          return raw;
        }

        const normalized: Record<string, unknown> = {};
        const normalizeWingClass = normalizeEnum(wingClassValues, wingClassAliases);

        for (const [key, value] of Object.entries(raw)) {
          normalized[normalizeWingClass(key) ?? key] = value;
        }

        return normalized;
      }, WingFactorsSchema.default({
        "EN A": 1.0,
        "EN B": 0.9,
        "EN C": 0.8,
        "EN C 2-liner": 0.7,
        "EN D": 0.6,
        "EN D 2-liner": 0.5,
      })),
  })
  .strip();

ConfigSchema satisfies z.ZodType<Config>;
