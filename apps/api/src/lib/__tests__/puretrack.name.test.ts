// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { roundGroupName, teamGroupName } from "../puretrack.js";

describe("PureTrack group names", () => {
  it("formats round dates without the locale comma", () => {
    const oldLocaleOutput = new Date("2026-06-09T00:00:00Z").toLocaleDateString("en-GB", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    });

    expect(oldLocaleOutput).toContain(",");
    expect(roundGroupName("Milk Hill", "2026-06-09")).toBe(
      "BCC Milk Hill Tue 09 Jun 26"
    );
    expect(teamGroupName("2026-06-09", "Team Alpha")).toBe(
      "BCC Tue 09 Jun 26 Team Alpha"
    );
  });

  it("formats several dates with the legacy .NET shape", () => {
    expect(roundGroupName("Hay Bluff", "2025-07-12")).toBe(
      "BCC Hay Bluff Sat 12 Jul 25"
    );
    expect(roundGroupName("Milk Hill", "2026-01-01")).toBe(
      "BCC Milk Hill Thu 01 Jan 26"
    );
  });
});
