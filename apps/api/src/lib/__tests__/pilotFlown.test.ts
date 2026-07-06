import { randomUUID } from "crypto";
import { describe, expect, test } from "vitest";

import { writePublicJson } from "../../__tests__/helpers/seed.js";
import { hasFlownInSeason } from "../pilotFlown.js";

// Distinct year per test so per-file container state can't bleed between cases.
// Step by 10 so a `year - 1` seed (prior-year test) never collides with any
// counter-produced year.
let yearCounter = 3000;
function nextYear(): number {
  yearCounter += 10;
  return yearCounter;
}

type PilotRow = { pilotId: string | null };

// Mirrors the public results/{year}.json blob written by recompute.ts:buildSeasonResults:
// SeasonResults = RoundResult[]; each teamResults[].pilots[] carries pilotId (string | null).
function seedResults(pilots: PilotRow[]): unknown[] {
  return [
    {
      roundId: randomUUID(),
      date: "2026-06-15",
      siteName: "Site A",
      teamResults: [
        {
          rank: 1,
          teamName: "Team A",
          clubName: "Club A",
          score: 100,
          pilots: pilots.map((p) => ({
            pilotId: p.pilotId,
            pilotName: p.pilotId ?? "Unknown",
            distance: 50,
            score: 50,
            wingClass: "EN B",
          })),
        },
      ],
    },
  ];
}

describe("hasFlownInSeason", () => {
  test("pilot present in that season's results → true", async () => {
    const year = nextYear();
    await writePublicJson(`results/${year}.json`, seedResults([{ pilotId: "pilot-a" }]));

    await expect(hasFlownInSeason("pilot-a", year)).resolves.toBe(true);
  });

  test("pilot absent from results → false", async () => {
    const year = nextYear();
    await writePublicJson(`results/${year}.json`, seedResults([{ pilotId: "pilot-a" }]));

    await expect(hasFlownInSeason("pilot-z", year)).resolves.toBe(false);
  });

  test("missing results blob (404) → false, no throw", async () => {
    // never seeded → readJson's download() throws Azure RestError 404
    const year = nextYear();

    await expect(hasFlownInSeason("pilot-a", year)).resolves.toBe(false);
  });

  test("only prior year seeded → queried year reports not flown (stale_state)", async () => {
    const year = nextYear();
    // Seed {year-1} only; the pilot flew last season but not this one.
    await writePublicJson(`results/${year - 1}.json`, seedResults([{ pilotId: "pilot-a" }]));

    await expect(hasFlownInSeason("pilot-a", year)).resolves.toBe(false);
  });

  test("results row with pilotId:null (+ foreign id) → false, no throw (null-safety)", async () => {
    const year = nextYear();
    await writePublicJson(
      `results/${year}.json`,
      seedResults([{ pilotId: null }, { pilotId: "some-other-pilot" }]),
    );

    // `=== pilotId` never matches a null row; must resolve false, never throw.
    await expect(hasFlownInSeason("pilot-target", year)).resolves.toBe(false);
  });
});
