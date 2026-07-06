import { describe, expect, test } from "vitest";
import { getPublicContainer } from "../../__tests__/helpers/azurite.js";
import { writePublicJson } from "../../__tests__/helpers/seed.js";
import { getActiveSeasonYear } from "../season.js";

describe("getActiveSeasonYear", () => {
  test("returns the year of the active-flagged season", async () => {
    // Given: seasons.json with a 2025 active season and a 2024 inactive one
    await writePublicJson("seasons.json", [
      { year: 2025, active: true },
      { year: 2024, active: false },
    ]);

    // When
    const year = await getActiveSeasonYear();

    // Then
    expect(year).toBe(2025);
  });

  test("falls back to the last season when none is active", async () => {
    // Given: only non-active seasons
    await writePublicJson("seasons.json", [
      { year: 2023, active: false },
      { year: 2024, active: false },
    ]);

    // When
    const year = await getActiveSeasonYear();

    // Then: the last entry's year is used as the fallback
    expect(year).toBe(2024);
  });

  test("returns the current calendar year when seasons.json is missing", async () => {
    // Given: seasons.json is absent (guarantee 404 regardless of prior tests)
    await getPublicContainer().getBlobClient("seasons.json").deleteIfExists();

    // When
    const year = await getActiveSeasonYear();

    // Then: current calendar year is returned, no throw
    expect(year).toBe(new Date().getFullYear());
  });
});
