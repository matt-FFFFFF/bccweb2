import { randomUUID } from "crypto";
import { BlobClient } from "@azure/storage-blob";
import type { Round, Season } from "@bccweb/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getPublicContainer } from "../../__tests__/helpers/azurite.js";
import {
  publicBlobExists,
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

async function readPublicBytes(path: string): Promise<Buffer> {
  const response = await getPublicContainer().getBlobClient(path).download();
  const chunks: Buffer[] = [];
  for await (const chunk of response.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
