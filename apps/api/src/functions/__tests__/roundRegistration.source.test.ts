// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCES = [
  new URL("../roundRegistration.ts", import.meta.url),
  new URL("../../../../../scripts/seed-fixtures.mjs", import.meta.url),
  new URL("../../../../../scripts/prepare-loadtest.mjs", import.meta.url),
] as const;

describe("round registration source contracts", () => {
  it("API and fixture setup sources contain no auto-allocation flag", () => {
    for (const sourceUrl of SOURCES) {
      expect(readFileSync(sourceUrl, "utf8")).not.toContain(
        "autoAllocatePilotsToRoundClub"
      );
    }
  });
});
