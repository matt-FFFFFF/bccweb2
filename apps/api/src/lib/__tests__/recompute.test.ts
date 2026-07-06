import { randomUUID } from "crypto";
import { BlobClient } from "@azure/storage-blob";
import type { Round, Season, SeasonResults } from "@bccweb/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getPublicContainer } from "../../__tests__/helpers/azurite.js";
import {
  publicBlobExists,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import { recomputeSeason } from "../recompute.js";

const restoredSpies: Array<() => void> = [];

afterEach(() => {
  while (restoredSpies.length) restoredSpies.pop()?.();
});

describe("recomputeSeason", () => {
  test("concurrent recomputes share one final season write", async () => {
    const { year, seasonPath } = await seedSeason();
    let seasonCopies = 0;
    const original = BlobClient.prototype.beginCopyFromURL;
    vi.spyOn(BlobClient.prototype, "beginCopyFromURL").mockImplementation(function (
      this: BlobClient,
      copySource,
      options
    ) {
      if (this.name === seasonPath) seasonCopies += 1;
      return original.call(this, copySource, options);
    });
    restoredSpies.push(() => vi.restoreAllMocks());

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => recomputeSeason(year))
    );

    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    expect(seasonCopies).toBe(1);
    const season = await readPublicJson<Season>(seasonPath);
    expect(season?.leagueTable).toHaveLength(1);
  });

  test("crash mid-recompute leaves prior final blob intact and tmp present", async () => {
    const { year, seasonPath } = await seedSeason();
    const prior: Season = { id: `season-${year}`, year, active: true, rounds: [], leagueTable: [] };
    await writePublicJson(seasonPath, prior);

    const original = BlobClient.prototype.beginCopyFromURL;
    vi.spyOn(BlobClient.prototype, "beginCopyFromURL").mockImplementation(function (
      this: BlobClient,
      copySource,
      options
    ) {
      if (this.name === seasonPath) {
        throw new Error("copy failed after tmp write");
      }
      return original.call(this, copySource, options);
    });
    restoredSpies.push(() => vi.restoreAllMocks());

    await expect(recomputeSeason(year)).rejects.toThrow("copy failed after tmp write");

    await expect(readPublicJson<Season>(seasonPath)).resolves.toEqual(prior);
    await expect(publicBlobExists(`${seasonPath}.tmp`)).resolves.toBe(true);
  });

  test("deterministic output is byte-identical across invocations", async () => {
    const { year, seasonPath } = await seedSeason();
    const snapshots: Buffer[] = [];

    for (let i = 0; i < 3; i += 1) {
      await recomputeSeason(year);
      snapshots.push(await readPublicBytes(seasonPath));
    }

    expect(Buffer.compare(snapshots[0], snapshots[1])).toBe(0);
    expect(Buffer.compare(snapshots[1], snapshots[2])).toBe(0);
  });

  test("results/{year}.json carries non-PII pilotId and excludes flightless slots", async () => {
    const year = 2600 + Math.floor(Math.random() * 7_000);
    const round = makeCompleteRound(year);
    const flightedSlot = round.teams[0].pilots[0];
    // Second slot has no flight/snapshot → must be filtered out (no stray pilot row).
    round.teams[0].pilots = [
      flightedSlot,
      {
        ...flightedSlot,
        placeInTeam: 2,
        isScoring: false,
        status: "Empty",
        noScore: true,
        pilotPoints: 0,
        pilotId: "pilot-b",
        snapshot: null,
        flight: null,
      },
    ];

    const season: Season = {
      id: `season-${year}`,
      year,
      active: true,
      rounds: [round.id],
      leagueTable: [],
    };
    await writePublicJson(`seasons/${year}.json`, season);
    await writePublicJson("rounds.json", [
      {
        id: round.id,
        date: round.date,
        siteId: round.site.id,
        siteName: round.site.name,
        status: round.status,
        seasonYear: year,
      },
    ]);
    await writePublicJson("pilots.json", [
      { id: "pilot-a", name: "Pilot A" },
      { id: "pilot-b", name: "Pilot B" },
    ]);
    await writePrivateJson(`rounds/${round.id}.json`, round);

    await recomputeSeason(year);

    const results = (await readPublicJson<SeasonResults>(`results/${year}.json`))!;
    const pilots = results[0].teamResults[0].pilots;
    expect(pilots).toHaveLength(1);
    expect(pilots[0].pilotId).toBe("pilot-a");
  });

  test("league total counts only the top leagueRoundScoresCounted scores (truncated) and never mutates a stored round team.score", async () => {
    const scores = [10.6, 20.6, 30.6, 40.6, 50.6, 60.6, 70.6];
    const { year, roundIds } = await seedScoredSeason(scores);

    await recomputeSeason(year);

    const season = (await readPublicJson<Season>(`seasons/${year}.json`))!;
    expect(season.leagueTable).toHaveLength(1);
    const entry = season.leagueTable[0];
    // Virgin config counts top-6; the lowest (10.6) is dropped. Sum 273.6 → trunc 273.
    expect(entry.countedRounds).toBe(6);
    expect(entry.totalScore).toBe(273);
    expect(Number.isInteger(entry.totalScore)).toBe(true);
    for (let i = 0; i < roundIds.length; i += 1) {
      const stored = (await readPrivateJson<Round>(`rounds/${roundIds[i]}.json`))!;
      expect(stored.teams[0].score).toBe(scores[i]);
    }
  });

  test("editing leagueRoundScoresCounted re-windows the league total on the next recompute (D13)", async () => {
    const scores = [10.6, 20.6, 30.6, 40.6, 50.6, 60.6, 70.6];
    const { year } = await seedScoredSeason(scores);

    await recomputeSeason(year);
    const before = (await readPublicJson<Season>(`seasons/${year}.json`))!;
    expect(before.leagueTable[0].totalScore).toBe(273);
    expect(before.leagueTable[0].countedRounds).toBe(6);

    await writePrivateJson("config.json", { leagueRoundScoresCounted: 2 });
    await recomputeSeason(year);

    const after = (await readPublicJson<Season>(`seasons/${year}.json`))!;
    // Top-2 only: 70.6 + 60.6 = 131.2 → trunc 131.
    expect(after.leagueTable[0].countedRounds).toBe(2);
    expect(after.leagueTable[0].totalScore).toBe(131);
  });
});

async function seedSeason(): Promise<{ year: number; seasonPath: string }> {
  const year = 2600 + Math.floor(Math.random() * 7_000);
  const round = makeCompleteRound(year);
  const seasonPath = `seasons/${year}.json`;
  const season: Season = {
    id: `season-${year}`,
    year,
    active: true,
    rounds: [round.id],
    leagueTable: [],
  };

  await writePublicJson(seasonPath, season);
  await writePublicJson("rounds.json", [
    {
      id: round.id,
      date: round.date,
      siteId: round.site.id,
      siteName: round.site.name,
      status: round.status,
      seasonYear: year,
    },
  ]);
  await writePublicJson("pilots.json", [{ id: "pilot-a", name: "Pilot A" }]);
  await writePrivateJson(`rounds/${round.id}.json`, round);
  return { year, seasonPath };
}

function makeCompleteRound(year: number): Round {
  return {
    id: randomUUID(),
    date: `${year}-06-15`,
    status: "Complete",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-a", name: "Site A" },
    season: { year },
    teams: [
      {
        id: "team-a",
        teamName: "Team A",
        club: { id: "club-a", name: "Club A" },
        score: 123.4,
        pilots: [
          {
            placeInTeam: 1,
            isScoring: true,
            status: "Filled",
            accountedFor: true,
            signToFly: true,
            noScore: false,
            pilotPoints: 123.4,
            pilotId: "pilot-a",
            snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
            flight: {
              id: "flight-a",
              distance: 123.4,
              scoringType: "XC",
              score: 123.4,
              wingFactor: 1,
              isManualLog: false,
            },
          },
        ],
      },
    ],
  };
}

function makeScoredRound(year: number, teamScore: number): Round {
  const round = makeCompleteRound(year);
  round.teams[0].score = teamScore;
  round.teams[0].pilots[0].pilotPoints = teamScore;
  round.teams[0].pilots[0].flight!.score = teamScore;
  return round;
}

async function seedScoredSeason(
  scores: number[]
): Promise<{ year: number; roundIds: string[] }> {
  const year = 2600 + Math.floor(Math.random() * 7_000);
  const rounds = scores.map((score) => makeScoredRound(year, score));
  const roundIds = rounds.map((round) => round.id);

  await writePublicJson(`seasons/${year}.json`, {
    id: `season-${year}`,
    year,
    active: true,
    rounds: roundIds,
    leagueTable: [],
  } satisfies Season);
  await writePublicJson(
    "rounds.json",
    rounds.map((round) => ({
      id: round.id,
      date: round.date,
      siteId: round.site.id,
      siteName: round.site.name,
      status: round.status,
      seasonYear: year,
    }))
  );
  await writePublicJson("pilots.json", [{ id: "pilot-a", name: "Pilot A" }]);
  for (const round of rounds) {
    await writePrivateJson(`rounds/${round.id}.json`, round);
  }

  return { year, roundIds };
}

async function readPublicBytes(path: string): Promise<Buffer> {
  const response = await getPublicContainer().getBlobClient(path).download();
  const chunks: Buffer[] = [];
  for await (const chunk of response.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
