// SPDX-License-Identifier: MPL-2.0
import { createRequire } from "node:module";
import IGCParser from "igc-parser";
import type { IGCFile } from "igc-parser";

import { runSanityChecks, type SanityFlag } from "./igcSanity.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const igcXcScoreModule: IgcXcScoreModule = require("igc-xc-score");
const { solver, scoringRules } = igcXcScoreModule;
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const igcXcScorePackage: IgcXcScorePackage = require("igc-xc-score/package.json");
const pkgVersion: string = igcXcScorePackage.version;

export interface ScoreIgcInput {
  buffer: Buffer;
  expectedDate: string;
  expectedPilotName?: string;
}

export interface ScoreIgcResult {
  distance: number;
  sanityFlags: SanityFlag[];
  scoredAt: string;
  scoredByVersion: string;
  parserErrors: string[];
}

interface IgcXcScorePackage {
  readonly version: string;
}

interface ScoreInfo {
  readonly distance?: number;
}

interface Solution {
  readonly optimal?: boolean;
  readonly scoreInfo?: ScoreInfo;
}

interface ScoringRule {
  readonly code?: string;
}

interface IgcXcScoreModule {
  readonly solver: (
    flight: IGCFile,
    scoringRulesSubset: readonly ScoringRule[],
    config: { readonly maxcycle: number }
  ) => Iterator<Solution, Solution>;
  readonly scoringRules: {
    readonly XCLeague?: readonly ScoringRule[];
  };
}

export const SOLVER_MAXCYCLE_MS = 30_000;

function parserErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parserErrorsFor(flight: IGCFile): string[] {
  return flight.errors.map((error) => error.message);
}

function findOpenDistanceRule(): ScoringRule {
  const odRule = scoringRules.XCLeague?.find((rule) => rule.code === "od");
  if (!odRule) {
    throw new Error("XCLeague 'od' variant not found — igc-xc-score upstream change");
  }

  return odRule;
}

function solveOpenDistance(flight: IGCFile, maxCycleMilliseconds: number): Solution | undefined {
  const iterator = solver(flight, [findOpenDistanceRule()], { maxcycle: maxCycleMilliseconds });
  const step = iterator.next();
  return step.value;
}

function finiteDistance(scoreInfo: ScoreInfo | undefined): number {
  const distance = scoreInfo?.distance;
  return typeof distance === "number" && Number.isFinite(distance) ? distance : 0;
}

function scoringResult(
  distance: number,
  sanityFlags: SanityFlag[],
  parserErrors: string[]
): ScoreIgcResult {
  return {
    distance,
    sanityFlags,
    scoredAt: new Date().toISOString(),
    scoredByVersion: pkgVersion,
    parserErrors,
  };
}

// scoreIgc is intentionally async (stable Promise-returning API contract for a scoring
// operation); the current igc-xc-score solver is synchronous CPU work.
// eslint-disable-next-line @typescript-eslint/require-await
export async function scoreIgc(input: ScoreIgcInput): Promise<ScoreIgcResult> {
  let flight: IGCFile;
  try {
    flight = IGCParser.parse(input.buffer.toString("utf8"), { lenient: true });
  } catch (error: unknown) {
    return scoringResult(0, ["NO_SCORING_SOLUTION"], [parserErrorMessage(error)]);
  }

  const parserErrors = parserErrorsFor(flight);
  const sanityFlags = runSanityChecks({
    flight,
    expectedDate: input.expectedDate,
    expectedPilotName: input.expectedPilotName,
  });
  const extraFlags = new Set<SanityFlag>();
  const solution = solveOpenDistance(flight, SOLVER_MAXCYCLE_MS);
  const distance = finiteDistance(solution?.scoreInfo);

  if (!solution?.scoreInfo) {
    extraFlags.add("NO_SCORING_SOLUTION");
  }

  if (solution && solution.optimal !== true) {
    extraFlags.add("SOLVER_TIMEOUT");
  }

  return scoringResult(distance, [...sanityFlags, ...extraFlags], parserErrors);
}
