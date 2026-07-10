// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Config } from "@bccweb/types";
import * as z from "zod/v4";

import { healed } from "./helpers.js";

// ─── Full-config nested factor schemas (LENIENT: heal + per-key defaults) ────

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

// Per-pilot-rating multiplier, keyed by exactly the `PilotRatingValue` union.
// Legacy: BaseController.cs:1661-1678 (GetPilotFactor — Club Pilot = 1,
// Pilot = 1, Advanced Pilot = 0.9).
const PilotFactorsSchema = z
  .object({
    "Club Pilot": healed(z.number(), 1).default(1),
    Pilot: healed(z.number(), 1).default(1),
    "Advanced Pilot": healed(z.number(), 0.9).default(0.9),
  })
  .strict();

// Round-score multiplier bucketed by clubs attending. Legacy:
// BaseController.cs:2254-2275 (GetClubsAttendingFactor — < 3 clubs → 0.5,
// == 3 → 0.75, > 3 → 1).
const ClubsAttendingFactorsSchema = z
  .object({
    fewerThanThreeClubs: healed(z.number(), 0.5).default(0.5),
    exactlyThreeClubs: healed(z.number(), 0.75).default(0.75),
    moreThanThreeClubs: healed(z.number(), 1).default(1),
  })
  .strict();

// Round-score multiplier bucketed by scoring-flight count. Legacy:
// BaseController.cs:2277-2309 (GetMinDistanceFactor — 1 flight → 0.2,
// 2 → 0.4, 3 → 0.6, 4 → 0.8, > 4 → 1).
const MinDistanceFactorsSchema = z
  .object({
    oneFlight: healed(z.number(), 0.2).default(0.2),
    twoFlights: healed(z.number(), 0.4).default(0.4),
    threeFlights: healed(z.number(), 0.6).default(0.6),
    fourFlights: healed(z.number(), 0.8).default(0.8),
    fiveOrMoreFlights: healed(z.number(), 1).default(1),
  })
  .strict();

/**
 * Full config-blob schema — the LENIENT (self-healing) read path.
 *
 * Every scalar both heals a corrupt value to its legacy default (`healed`) and
 * fills a missing key (`.default`); every nested factor map heals per-key AND
 * hydrates the whole object when it is absent. A partial input such as
 * `{ pilotFactors: { Pilot: 1.1 } }` therefore comes back with its sibling
 * factors filled from defaults — correct when reading a stored blob, but WRONG
 * for a PATCH body (see `ConfigPatchSchema` for the strict, no-default variant).
 *
 * Default VALUES are the legacy .NET app's — do NOT change without re-deriving
 * from source (they feed the W2.x scoring numeric-fidelity oracle):
 *   - counts + wingFactors ...... Web.config:97-109
 *   - pilotFactors .............. BaseController.cs:1661-1678 (GetPilotFactor)
 *   - clubsAttendingFactors ..... BaseController.cs:2254-2275 (GetClubsAttendingFactor)
 *   - minDistanceFactors ........ BaseController.cs:2277-2309 (GetMinDistanceFactor)
 *   - taskMaxPoints ............. BaseController.cs:2461 (`int taskMaxPoints = 1000`)
 */
export const ConfigSchema = z
  .object({
    maxTeamsInClub: healed(z.number(), 2).default(2),
    maxPilotsInTeam: healed(z.number(), 9).default(9),
    maxScoringPilotsInTeam: healed(z.number(), 6).default(6),
    maxPilotScoresCountedPerTeam: healed(z.number(), 4).default(4),
    leagueRoundScoresCounted: healed(z.number(), 6).default(6),
    flightDateValidationEnabled: healed(z.boolean(), true).default(true),
    wingFactors: WingFactorsSchema.default({
      "EN A": 1.0,
      "EN B": 0.9,
      "EN C": 0.8,
      "EN C 2-liner": 0.7,
      "EN D": 0.6,
      "EN D 2-liner": 0.5,
    }),
    taskMaxPoints: healed(z.number(), 1000).default(1000),
    pilotFactors: PilotFactorsSchema.default({
      "Club Pilot": 1,
      Pilot: 1,
      "Advanced Pilot": 0.9,
    }),
    clubsAttendingFactors: ClubsAttendingFactorsSchema.default({
      fewerThanThreeClubs: 0.5,
      exactlyThreeClubs: 0.75,
      moreThanThreeClubs: 1,
    }),
    minDistanceFactors: MinDistanceFactorsSchema.default({
      oneFlight: 0.2,
      twoFlights: 0.4,
      threeFlights: 0.6,
      fourFlights: 0.8,
      fiveOrMoreFlights: 1,
    }),
  })
  .strip();

ConfigSchema satisfies z.ZodType<Config>;

// ─── Patch schemas (STRICT, no-default) for admin PATCH bodies ───────────────

const WingFactorsPatchSchema = z
  .object({
    "EN A": z.number(),
    "EN B": z.number(),
    "EN C": z.number(),
    "EN C 2-liner": z.number(),
    "EN D": z.number(),
    "EN D 2-liner": z.number(),
  })
  .partial()
  .strict();

const PilotFactorsPatchSchema = z
  .object({
    "Club Pilot": z.number(),
    Pilot: z.number(),
    "Advanced Pilot": z.number(),
  })
  .partial()
  .strict();

const ClubsAttendingFactorsPatchSchema = z
  .object({
    fewerThanThreeClubs: z.number(),
    exactlyThreeClubs: z.number(),
    moreThanThreeClubs: z.number(),
  })
  .partial()
  .strict();

const MinDistanceFactorsPatchSchema = z
  .object({
    oneFlight: z.number(),
    twoFlights: z.number(),
    threeFlights: z.number(),
    fourFlights: z.number(),
    fiveOrMoreFlights: z.number(),
  })
  .partial()
  .strict();

/**
 * Admin PATCH-body schema — the STRICT counterpart to the lenient `ConfigSchema`.
 *
 * Every top-level field is `.optional()` and NO key carries a `.default()`, so
 * the schema NEVER injects a value the caller did not send. Nested factor maps
 * are `.partial().strict()`: a caller may send a subset of factor keys, but any
 * unknown key is rejected outright.
 *
 * Break-glass rationale — why full-vs-patch MUST diverge:
 *   `ConfigSchema.parse({ pilotFactors: { Pilot: 1.1 } })` hydrates the sibling
 *   factors (`Club Pilot`, `Advanced Pilot`) from defaults — great for reading a
 *   stored blob, but for a PATCH it would SILENTLY RESET the factors the admin
 *   never touched. `ConfigPatchSchema.parse({ pilotFactors: { Pilot: 1.1 } })`
 *   instead yields exactly `{ pilotFactors: { Pilot: 1.1 } }`, so the W3.3
 *   deep-merge overwrites only `pilotFactors.Pilot` and leaves every sibling
 *   factor intact.
 *
 * (W3.3 wires this into `updateConfig`; this task only DEFINES and EXPORTS it.)
 */
export const ConfigPatchSchema = z
  .object({
    maxTeamsInClub: z.number().optional(),
    maxPilotsInTeam: z.number().optional(),
    maxScoringPilotsInTeam: z.number().optional(),
    maxPilotScoresCountedPerTeam: z.number().optional(),
    leagueRoundScoresCounted: z.number().optional(),
    flightDateValidationEnabled: z.boolean().optional(),
    wingFactors: WingFactorsPatchSchema.optional(),
    taskMaxPoints: z.number().optional(),
    pilotFactors: PilotFactorsPatchSchema.optional(),
    clubsAttendingFactors: ClubsAttendingFactorsPatchSchema.optional(),
    minDistanceFactors: MinDistanceFactorsPatchSchema.optional(),
  })
  .strip();
