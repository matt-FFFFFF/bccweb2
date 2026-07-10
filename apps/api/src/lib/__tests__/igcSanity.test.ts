// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/// <reference types="node" />
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import IGCParser from "igc-parser";
import type { IGCFile } from "igc-parser";

import { runSanityChecks } from "../igcSanity.js";
import type { SanityFlag } from "../igcSanity.js";

const FIXTURE_DIR = new URL("./fixtures/igc/", import.meta.url);

function parseFixture(name: string): IGCFile {
  const fixtureUrl = new URL(name, FIXTURE_DIR);
  return IGCParser.parse(readFileSync(fixtureUrl, "utf8"), { lenient: true });
}

function flagsFor(flight: IGCFile, expectedDate = flight.date): SanityFlag[] {
  return runSanityChecks({ flight, expectedDate, expectedPilotName: flight.pilot ?? undefined });
}

describe("runSanityChecks", () => {
  it("emits GPS_SPIKE when an adjacent fix exceeds the ground-speed threshold", () => {
    // Given: an IGC fixture with one deliberately shifted latitude fix.
    const flight = parseFixture("gps-spike.igc");

    // When: sanity checks run against the parsed flight.
    const flags = flagsFor(flight);

    // Then: the speed spike is reported once.
    expect(flags).toContain("GPS_SPIKE");
    expect(flags.filter((flag) => flag === "GPS_SPIKE")).toHaveLength(1);
  });

  it("emits NON_MONOTONIC_TIMESTAMPS when adjacent fixes go backwards", () => {
    // Given: an IGC fixture with two adjacent B-records swapped.
    const flight = parseFixture("non-monotonic.igc");

    // When: sanity checks run against the parsed flight.
    const flags = flagsFor(flight);

    // Then: the timestamp-order violation is reported once.
    expect(flags).toContain("NON_MONOTONIC_TIMESTAMPS");
    expect(flags.filter((flag) => flag === "NON_MONOTONIC_TIMESTAMPS")).toHaveLength(1);
  });

  it("does not emit identity, date, speed, or timestamp flags for the clean d3p fixture", () => {
    // Given: the clean upstream d3p fixture and its real round date.
    const flight = parseFixture("d3p.igc");

    // When: sanity checks run with matching metadata.
    const flags = runSanityChecks({
      flight,
      expectedDate: "2019-06-15",
      expectedPilotName: flight.pilot ?? undefined,
    });

    // Then: no false-positive flags are emitted for the required clean dimensions.
    expect(flags).not.toContain("IGC_DATE_MISMATCH");
    expect(flags).not.toContain("IGC_PILOT_MISMATCH");
    expect(flags).not.toContain("GPS_SPIKE");
    expect(flags).not.toContain("NON_MONOTONIC_TIMESTAMPS");
    expect(flags).not.toContain("LOW_FIX_RATE");
  });

  it("emits IGC_DATE_MISMATCH when the fixture date differs by more than one day", () => {
    // Given: the clean d3p fixture and a date five days after the flight date.
    const flight = parseFixture("d3p.igc");

    // When: sanity checks compare the IGC date with the expected round date.
    const flags = runSanityChecks({ flight, expectedDate: "2019-06-20" });

    // Then: the date mismatch is reported.
    expect(flags).toContain("IGC_DATE_MISMATCH");
  });

  it("emits IGC_PILOT_MISMATCH when a non-null fixture pilot differs from the expected pilot", () => {
    // Given: the d3p fixture has a non-null pilot field.
    const flight = parseFixture("d3p.igc");

    // When: sanity checks compare it with a deliberately wrong pilot name.
    const flags = runSanityChecks({
      flight,
      expectedDate: "2019-06-15",
      expectedPilotName: "Definitely Not The Fixture Pilot",
    });

    // Then: a mismatch is reported because igc-parser returned a non-null pilot value.
    expect(flight.pilot).not.toBeNull();
    expect(flags).toContain("IGC_PILOT_MISMATCH");
  });
});
