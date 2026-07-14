// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
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

const leaseHook = vi.hoisted(() => ({
  beforeRenewing: null as null | ((path: string) => Promise<void>),
  onRenewingConflict: null as null | ((path: string) => Promise<void>),
}));

vi.mock("../blob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../blob.js")>();
  return {
    ...actual,
    withLeaseRenewing: async <T>(
      path: string,
      fn: (leaseId: string) => Promise<T>,
      opts: Parameters<typeof actual.withLeaseRenewing>[2] = {},
    ) => {
      const beforeRenewing = leaseHook.beforeRenewing;
      if (beforeRenewing) await beforeRenewing(path);
      try {
        return await actual.withLeaseRenewing(path, fn, opts);
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        const hook = leaseHook.onRenewingConflict;
        if (hook && (statusCode === 409 || statusCode === 412)) await hook(path);
        throw err;
      }
    },
  };
});

import { recomputeSeason } from "../recompute.js";

const restoredSpies: Array<() => void> = [];

afterEach(() => {
  leaseHook.beforeRenewing = null;
  leaseHook.onRenewingConflict = null;
  while (restoredSpies.length) restoredSpies.pop()?.();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("recomputeSeason", () => {
  test("a request arriving before the first swap triggers a second pass that publishes the latest round score", async () => {
    // Given: recompute A has snapshotted score X and is paused immediately before its first season swap.
    const { year, seasonPath, roundId } = await seedSeason();
    const firstSeasonSwapEntered = Promise.withResolvers<void>();
    const releaseFirstSeasonSwap = Promise.withResolvers<void>();
    let seasonCopies = 0;
    const original = BlobClient.prototype.beginCopyFromURL;
    vi.spyOn(BlobClient.prototype, "beginCopyFromURL").mockImplementation(async function (
      this: BlobClient,
      copySource,
      options
    ) {
      if (this.name === seasonPath) {
        seasonCopies += 1;
        if (seasonCopies === 1) {
          firstSeasonSwapEntered.resolve();
          await releaseFirstSeasonSwap.promise;
        }
      }
      return original.call(this, copySource, options);
    });
    restoredSpies.push(() => vi.restoreAllMocks());

    const recomputeA = recomputeSeason(year);
    await Promise.race([
      firstSeasonSwapEntered.promise,
      recomputeA.then(() => {
        throw new Error("recompute A completed before reaching the season swap");
      }),
    ]);
    const latestScore = 222;
    await writeRoundScore(roundId, latestScore);

    // When: recompute B arrives while A is still in flight, then A is allowed to publish.
    const recomputeB = recomputeSeason(year);
    releaseFirstSeasonSwap.resolve();
    await Promise.all([recomputeA, recomputeB]);

    // Then: B was not dropped; its second pass publishes score Y to both derived blobs.
    expect(seasonCopies).toBe(2);
    await expectPublishedScore(year, latestScore);
  });

  test("a dirty request runs a second pass after the in-flight pass fails", async () => {
    // Given: recompute A is paused before a season swap that will fail.
    const { year, seasonPath, roundId } = await seedSeason();
    const firstSeasonSwapEntered = Promise.withResolvers<void>();
    const releaseFirstSeasonSwap = Promise.withResolvers<void>();
    let seasonCopies = 0;
    const original = BlobClient.prototype.beginCopyFromURL;
    vi.spyOn(BlobClient.prototype, "beginCopyFromURL").mockImplementation(async function (
      this: BlobClient,
      copySource,
      options,
    ) {
      if (this.name === seasonPath) {
        seasonCopies += 1;
        if (seasonCopies === 1) {
          firstSeasonSwapEntered.resolve();
          await releaseFirstSeasonSwap.promise;
          throw new Error("first pass swap failed");
        }
      }
      return original.call(this, copySource, options);
    });

    const recomputeA = recomputeSeason(year);
    await firstSeasonSwapEntered.promise;
    const latestScore = 244;
    await writeRoundScore(roundId, latestScore);

    // When: recompute B marks the failed in-flight pass dirty before it rejects.
    const recomputeB = recomputeSeason(year);
    releaseFirstSeasonSwap.resolve();
    await Promise.all([recomputeA, recomputeB]);

    // Then: the pending pass is not erased by the failure and publishes the latest score.
    expect(seasonCopies).toBe(2);
    await expectPublishedScore(year, latestScore);
  });

  test("a recompute waiting on another host's season lease reads the latest committed round score", async () => {
    // Given: another host holds the existing season lock and this host observes lease contention.
    const { year, roundId } = await seedSeason();
    const lockPath = `seasons/${year}.json.lock`;
    await writePublicJson(lockPath, { purpose: "recompute-lock" });
    const leaseClient = getPublicContainer().getBlockBlobClient(lockPath).getBlobLeaseClient();
    const lease = await leaseClient.acquireLease(15);
    expect(lease.leaseId).toBeTruthy();
    const firstConflict = Promise.withResolvers<void>();
    leaseHook.onRenewingConflict = async (path) => {
      if (path === lockPath) firstConflict.resolve();
    };

    // When: recompute conflicts, score Y commits while it waits, and the other host releases the lock.
    const waitingRecompute = recomputeSeason(year);
    await firstConflict.promise;
    const latestScore = 333;
    await writeRoundScore(roundId, latestScore);
    await leaseClient.releaseLease();
    await waitingRecompute;

    // Then: the waiting pass snapshots after lease acquisition and publishes score Y.
    await expectPublishedScore(year, latestScore);
  });

  test("production retry policy outwaits acquisition contention beyond the old attempt window", async () => {
    // Given: acquisition remains contended for 30.5 simulated seconds, longer than the former retry budget.
    const { year } = await seedSeason();
    vi.useFakeTimers();
    const startedAt = Date.now();
    const firstConflict = Promise.withResolvers<void>();
    const acquisitionWindowElapsed = Promise.withResolvers<void>();
    const allowAcquisition = Promise.withResolvers<void>();
    let attempts = 0;
    leaseHook.beforeRenewing = async () => {
      attempts += 1;
      if (Date.now() - startedAt < 30_500) {
        firstConflict.resolve();
        throw Object.assign(new Error("lease held"), { statusCode: 409 });
      }
      acquisitionWindowElapsed.resolve();
      await allowAcquisition.promise;
    };

    // When: the production retry loop advances beyond a normal 30-second lease lifetime.
    const recompute = recomputeSeason(year);
    await firstConflict.promise;
    for (let elapsedMs = 0; elapsedMs <= 30_500; elapsedMs += 250) {
      await vi.advanceTimersByTimeAsync(250);
    }
    await Promise.race([
      acquisitionWindowElapsed.promise,
      recompute.then(
        () => { throw new Error("recompute completed before the simulated lease expired"); },
        (err: unknown) => { throw err; },
      ),
    ]);
    vi.useRealTimers();
    allowAcquisition.resolve();
    await recompute;

    // Then: acquisition was still retried after the old 40-attempt window and eventually succeeded.
    expect(attempts).toBeGreaterThan(40);
  });

  test("a callback-originated lease-shaped conflict propagates without reacquiring", async () => {
    // Given: lease acquisition succeeds, but the first publish callback throws an unrelated 409.
    const { year, seasonPath } = await seedSeason();
    let seasonCopies = 0;
    vi.spyOn(BlobClient.prototype, "beginCopyFromURL").mockImplementationOnce(function (
      this: BlobClient,
    ) {
      if (this.name === seasonPath) seasonCopies += 1;
      throw Object.assign(new Error("callback conflict"), { statusCode: 409 });
    });

    // When: recompute reaches the publish callback.
    const recompute = recomputeSeason(year);

    // Then: the callback error propagates immediately and the callback executes only once.
    await expect(recompute).rejects.toThrow("callback conflict");
    expect(seasonCopies).toBe(1);
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

async function seedSeason(): Promise<{ year: number; seasonPath: string; roundId: string }> {
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
  return { year, seasonPath, roundId: round.id };
}

async function writeRoundScore(roundId: string, score: number): Promise<void> {
  const round = (await readPrivateJson<Round>(`rounds/${roundId}.json`))!;
  round.teams[0].score = score;
  round.teams[0].pilots[0].pilotPoints = score;
  await writePrivateJson(`rounds/${roundId}.json`, round);
}

async function expectPublishedScore(year: number, score: number): Promise<void> {
  const season = (await readPublicJson<Season>(`seasons/${year}.json`))!;
  const results = (await readPublicJson<SeasonResults>(`results/${year}.json`))!;
  expect(season.leagueTable[0].totalScore).toBe(score);
  expect(results[0].teamResults[0].score).toBe(score);
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
