// SPDX-License-Identifier: MPL-2.0
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { scoreIgc } from "../igcScoring.js";

const FIXTURE_DIR = new URL("./fixtures/igc/", import.meta.url);

function readFixture(name: string): Buffer {
  return readFileSync(new URL(name, FIXTURE_DIR));
}

describe("scoreIgc", () => {
  afterEach(() => {
    vi.doUnmock("node:module");
  });

  it("returns raw XCLeague open-distance kilometres when the d3p fixture is scored", async () => {
    // Given: a valid IGC trace with the expected round date.
    const buffer = readFixture("d3p.igc");

    // When: the pure scoring wrapper scores the trace.
    const result = await scoreIgc({ buffer, expectedDate: "2019-06-15" });

    // Then: raw distance is a plausible OD kilometres value, not a multiplied score.
    expect(result.distance).toBeGreaterThan(50);
    expect(result.distance).toBeLessThan(200);
    expect(result.parserErrors).toHaveLength(0);
    expect(result.scoredByVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(new Date(result.scoredAt).toISOString()).toBe(result.scoredAt);
  }, 60_000);

  it("does not throw when a hiking trace has no meaningful scoring solution", async () => {
    // Given: a non-flight hiking fixture.
    const buffer = readFixture("hiking-up.igc");

    // When: the trace is scored.
    const result = await scoreIgc({ buffer, expectedDate: "2019-06-15" });

    // Then: the fixture's observed OD distance is returned instead of throwing.
    expect(result.distance).toBeGreaterThan(33);
    expect(result.distance).toBeLessThan(34);
  }, 60_000);

  it("returns parser errors instead of throwing when the fixture is corrupted", async () => {
    // Given: an IGC fixture that lacks the mandatory HFDTE record.
    const buffer = readFixture("corrupted.igc");

    // When: the wrapper attempts to parse and score it.
    const result = await scoreIgc({ buffer, expectedDate: "2019-06-15" });

    // Then: parse failure is represented in the result contract.
    expect(result.distance).toBe(0);
    expect(result.parserErrors.length).toBeGreaterThan(0);
    expect(result.sanityFlags).toContain("NO_SCORING_SOLUTION");
  });

  it("includes GPS_SPIKE when scoring a trace with an impossible adjacent fix", async () => {
    // Given: an IGC fixture with one shifted latitude fix.
    const buffer = readFixture("gps-spike.igc");

    // When: the wrapper scores the trace.
    const result = await scoreIgc({ buffer, expectedDate: "2019-06-15" });

    // Then: T7 sanity flags are composed into the scoring result.
    expect(result.distance).toBeGreaterThanOrEqual(0);
    expect(result.sanityFlags).toContain("GPS_SPIKE");
  }, 60_000);

  it("includes NON_MONOTONIC_TIMESTAMPS when scoring a trace with reordered fixes", async () => {
    // Given: an IGC fixture with adjacent B records swapped.
    const buffer = readFixture("non-monotonic.igc");

    // When: the wrapper scores the trace.
    const result = await scoreIgc({ buffer, expectedDate: "2019-06-15" });

    // Then: T7 timestamp-order detection is preserved.
    expect(result.distance).toBeGreaterThanOrEqual(0);
    expect(result.sanityFlags).toContain("NON_MONOTONIC_TIMESTAMPS");
  }, 60_000);

  it("includes SOLVER_TIMEOUT when the solver stops before proving optimality", async () => {
    // Given: igc-xc-score pauses before returning an optimal final solution.
    vi.resetModules();
    vi.doMock("node:module", () => ({
      createRequire: () => (id: string) => {
        if (id === "igc-xc-score") {
          return {
            scoringRules: { XCLeague: [{ code: "od" }] },
            solver: () => ({
              next: () => ({
                done: false,
                value: { optimal: false, scoreInfo: { distance: 12.3 } },
              }),
            }),
          };
        }

        if (id === "igc-xc-score/package.json") {
          return { version: "1.8.0" };
        }

        throw new Error(`Unexpected require id ${id}`);
      },
    }));
    const { scoreIgc: scoreIgcWithPausedSolver } = await import("../igcScoring.js");
    const buffer = readFixture("d3p.igc");

    // When: the wrapper observes the yielded partial solution.
    const result = await scoreIgcWithPausedSolver({ buffer, expectedDate: "2019-06-15" });

    // Then: the best partial result is retained and the timeout is flagged.
    expect(result.distance).toBeGreaterThanOrEqual(0);
    expect(result.sanityFlags).toContain("SOLVER_TIMEOUT");
  }, 60_000);
});
