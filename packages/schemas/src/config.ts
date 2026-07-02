import type { Config } from "@bccweb/types";
import * as z from "zod/v4";

import { healed } from "./helpers.js";

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
    wingFactors: WingFactorsSchema.default({
      "EN A": 1.0,
      "EN B": 0.9,
      "EN C": 0.8,
      "EN C 2-liner": 0.7,
      "EN D": 0.6,
      "EN D 2-liner": 0.5,
    }),
  })
  .strip();

ConfigSchema satisfies z.ZodType<Config>;
