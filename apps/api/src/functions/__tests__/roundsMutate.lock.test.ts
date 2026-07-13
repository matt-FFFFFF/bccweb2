// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Round, RoundBrief, Season } from "@bccweb/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import {
  makeUser,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import { computeBriefHash } from "../../lib/signTofly/briefVersion.js";
import * as pureTrack from "../../lib/puretrack.js";

const blobWriteControl = vi.hoisted(() => ({
  failRoundAfterBriefWrite: false,
  sawBriefWrite: false,
}));
vi.mock("../../lib/blobJson.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blobJson.js")>();
  return {
    ...actual,
    writePrivateJson: vi.fn(async (path, schema, data, leaseId, options) => {
      if (path.startsWith("round-briefs/")) blobWriteControl.sawBriefWrite = true;
      if (
        path.startsWith("rounds/") &&
        blobWriteControl.failRoundAfterBriefWrite &&
        blobWriteControl.sawBriefWrite
      ) {
        throw new Error("injected atomic unlock round write failure");
      }
      return actual.writePrivateJson(path, schema, data, leaseId, options);
    }),
  };
});

const pdfMock = vi.hoisted(() => ({
  generateBriefPdf: vi.fn(),
}));
vi.mock("../../lib/pdf.js", () => ({
  generateBriefPdf: pdfMock.generateBriefPdf,
}));

vi.mock("../../lib/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queue.js")>()),
  enqueueBriefPdf: vi.fn(),
  enqueuePureTrackGroupJob: vi.fn(),
}));

const briefPdfMock = vi.hoisted(() => ({
  setBriefPdfStatus: vi.fn(),
  realSetBriefPdfStatus:
    undefined as unknown as (typeof import("../../lib/briefPdf.js"))["setBriefPdfStatus"],
}));
vi.mock("../../lib/briefPdf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/briefPdf.js")>();
  briefPdfMock.realSetBriefPdfStatus = actual.setBriefPdfStatus;
  return { ...actual, setBriefPdfStatus: briefPdfMock.setBriefPdfStatus };
});

import { enqueueBriefPdf, enqueuePureTrackGroupJob } from "../../lib/queue.js";
import { setBriefPdfStatus } from "../../lib/briefPdf.js";
import { setPureTrackStatus } from "../../lib/puretrackStatus.js";
import "../roundsMutate.js";

interface Ctx {
  readonly roundId: string;
  readonly teamId: string;
  readonly pilotId: string;
  readonly adminUserId: string;
  readonly adminEmail: string;
  readonly clubId: string;
  readonly year: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function seedBriefCompleteRound(): Promise<Ctx> {
  const year = 3000 + Math.floor(Math.random() * 6_000);
  const clubId = randomUUID();
  const pilotId = randomUUID();
  const teamId = randomUUID();
  const roundId = randomUUID();
  const { user: admin } = await makeUser({ roles: ["Admin"], clubId });

  const round: Round = {
    id: roundId,
    date: `${year}-06-09`,
    status: "BriefComplete",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    pureTrackGroupId: 100,
    pureTrackGroupName: "Stale round group",
    pureTrackGroupSlug: "stale-round-group",
    site: {
      id: randomUUID(),
      name: "Milk Hill",
      parkingW3W: "filled.count.soap",
      briefingW3W: "brief.count.soap",
      takeOffW3W: "takeoff.count.soap",
    },
    organisingClub: { id: clubId, name: "Test Club" },
    season: { year },
    teams: [
      {
        id: teamId,
        teamName: "Alpha",
        club: { id: clubId, name: "Test Club" },
        score: 0,
        pureTrackGroupId: 101,
        pureTrackGroupSlug: "stale-team-group",
        pilots: [
          {
            placeInTeam: 1,
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            pilotId,
            snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
            flight: null,
          },
        ],
      },
    ],
  };

  await writePrivateJson(`rounds/${roundId}.json`, round);
  await writePrivateJson(`pilots/${pilotId}.json`, {
    id: pilotId,
    person: { firstName: "Lock", lastName: "Pilot", fullName: "Lock Pilot" },
    currentClub: { id: clubId, name: "Test Club" },
    wingClass: "EN B",
    pilotRating: "Pilot",
    bhpaNumber: 12345,
  });
  await writePublicJson(`seasons/${year}.json`, {
    id: `season-${year}`,
    year,
    active: true,
    rounds: [roundId],
    leagueTable: [],
  } satisfies Season);
  await writePublicJson("rounds.json", [
    {
      id: roundId,
      date: round.date,
      siteId: round.site.id,
      siteName: round.site.name,
      status: round.status,
      seasonYear: year,
    },
  ]);

  return { roundId, teamId, pilotId, adminUserId: admin.id, adminEmail: admin.email, clubId, year };
}

function makeBrief(ctx: Ctx, overrides: Partial<RoundBrief> = {}): RoundBrief {
  return {
    roundId: ctx.roundId,
    generatedAt: "2026-06-01T08:00:00.000Z",
    date: `${ctx.year}-06-09`,
    siteName: "Milk Hill",
    parkingW3W: "filled.count.soap",
    briefingW3W: "brief.count.soap",
    takeOffW3W: "takeoff.count.soap",
    windSpeedDirection: "NW 15kt",
    pureTrackGroupName: "Stale round group",
    pureTrackGroupSlug: "stale-round-group",
    version: 1,
    teams: [
      {
        teamName: "Alpha",
        clubName: "Test Club",
        pureTrackGroupId: 101,
        pureTrackGroupSlug: "stale-team-group",
        pilots: [],
      },
    ],
    ...overrides,
  };
}

function frozenBrief(ctx: Ctx, overrides: Partial<RoundBrief> = {}): RoundBrief {
  const brief = makeBrief(ctx, overrides);
  return { ...brief, hash: computeBriefHash(brief) };
}

function lock(ctx: Ctx) {
  return invoke(
    "lockRound",
    makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
      method: "POST",
      params: { id: ctx.roundId },
    }),
  );
}

function unlock(ctx: Ctx) {
  return invoke(
    "unlockRound",
    makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
      method: "POST",
      params: { id: ctx.roundId },
    }),
  );
}

async function readRequiredRound(roundId: string): Promise<Round> {
  const round = await readPrivateJson<Round>(`rounds/${roundId}.json`);
  if (round === null) throw new Error(`Round ${roundId} was not written`);
  return round;
}

function readPrivateBytes(path: string): Promise<Buffer> {
  return getPrivateContainer().getBlobClient(path).downloadToBuffer();
}

describe("lockRound async brief PDF queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blobWriteControl.failRoundAfterBriefWrite = false;
    blobWriteControl.sawBriefWrite = false;
    vi.mocked(enqueueBriefPdf).mockResolvedValue(undefined);
    vi.mocked(enqueuePureTrackGroupJob).mockResolvedValue(undefined);
    vi.mocked(setBriefPdfStatus).mockImplementation(briefPdfMock.realSetBriefPdfStatus);
  });

  it("relock clears stale PureTrack echoes before building the brief and enqueues pending jobs", async () => {
    const ctx = await seedBriefCompleteRound();
    const createPureTrackGroupsSpy = vi.spyOn(pureTrack, "createPureTrackGroups");
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, frozenBrief(ctx));
    vi.mocked(enqueuePureTrackGroupJob).mockImplementationOnce(async (job) => {
      const committed = await readPrivateJson<Round>(`rounds/${job.roundId}.json`);
      expect(committed?.status).toBe("Locked");
      expect(committed?.pureTrack).toMatchObject({ status: "pending", attemptId: job.attemptId });
    });

    const lockRes = await lock(ctx);

    expect(lockRes.status).toBe(200);
    const lockedRound = await readRequiredRound(ctx.roundId);
    expect(lockedRound.status).toBe("Locked");
    expect(lockedRound.brief?.pdfStatus).toBe("pending");
    expect(lockedRound.brief?.pdfAttemptId).toMatch(UUID_RE);
    expect(lockedRound.brief?.pdfUpdatedAt).toBeTruthy();
    expect(lockedRound.pureTrack?.status).toBe("pending");
    expect(lockedRound.pureTrack?.attemptId).toMatch(UUID_RE);
    expect(lockedRound.pureTrackGroupId).toBeUndefined();
    expect(lockedRound.pureTrackGroupName).toBeUndefined();
    expect(lockedRound.pureTrackGroupSlug).toBeUndefined();
    expect(lockedRound.teams[0]?.pureTrackGroupId).toBeUndefined();
    expect(lockedRound.teams[0]?.pureTrackGroupSlug).toBeUndefined();
    expect(enqueueBriefPdf).toHaveBeenCalledTimes(1);
    expect(enqueueBriefPdf).toHaveBeenCalledWith({
      roundId: ctx.roundId,
      briefVersion: lockedRound.brief?.version,
      pdfAttemptId: lockedRound.brief?.pdfAttemptId,
    });
    expect(enqueuePureTrackGroupJob).toHaveBeenCalledWith({
      roundId: ctx.roundId,
      attemptId: lockedRound.pureTrack?.attemptId,
    });
    expect(enqueuePureTrackGroupJob).toHaveBeenCalledTimes(1);
    expect(createPureTrackGroupsSpy).not.toHaveBeenCalled();
    const lockedBrief = await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`);
    expect(lockedBrief?.pureTrackGroupName).toBeUndefined();
    expect(lockedBrief?.pureTrackGroupSlug).toBeUndefined();
    expect(lockedBrief?.teams[0]?.pureTrackGroupId).toBeUndefined();
    expect(lockedBrief?.teams[0]?.pureTrackGroupSlug).toBeUndefined();
    expect(pdfMock.generateBriefPdf).not.toHaveBeenCalled();

  });

  it.each(["pending", "processing"] as const)(
    "returns 409 and byte-preserves the round and brief while PureTrack is %s",
    async (status) => {
      const ctx = await seedBriefCompleteRound();
      const briefPath = `round-briefs/${ctx.roundId}.json`;
      const roundPath = `rounds/${ctx.roundId}.json`;
      await writePrivateJson(briefPath, frozenBrief(ctx));
      await lock(ctx);
      const round = await readRequiredRound(ctx.roundId);
      if (status === "processing") {
        await setPureTrackStatus(ctx.roundId, "processing", {
          expectAttemptId: round.pureTrack?.attemptId,
          fromStatuses: ["pending"],
        });
      }
      const roundBefore = await readPrivateBytes(roundPath);
      const briefBefore = await readPrivateBytes(briefPath);

      const res = await unlock(ctx);

      expect(res.status).toBe(409);
      expect(res.jsonBody).toMatchObject({ code: "PURETRACK_IN_PROGRESS" });
      expect(await readPrivateBytes(roundPath)).toEqual(roundBefore);
      expect(await readPrivateBytes(briefPath)).toEqual(briefBefore);
    },
  );

  it("atomically clears round and brief echoes while preserving hash, signature, and scoring", async () => {
    const ctx = await seedBriefCompleteRound();
    const briefPath = `round-briefs/${ctx.roundId}.json`;
    const roundPath = `rounds/${ctx.roundId}.json`;
    const signaturePath = `signatures/${ctx.roundId}/preserved.json`;
    await writePrivateJson(briefPath, frozenBrief(ctx));
    await writePrivateJson(signaturePath, { signed: true, briefVersion: 1 });
    await lock(ctx);
    const locked = await readRequiredRound(ctx.roundId);
    await setPureTrackStatus(ctx.roundId, "ready", {
      expectAttemptId: locked.pureTrack?.attemptId,
      fromStatuses: ["pending"],
    });
    const readyRound = await readRequiredRound(ctx.roundId);
    readyRound.pureTrackGroupId = 200;
    readyRound.pureTrackGroupName = "Fresh round group";
    readyRound.pureTrackGroupSlug = "fresh-round-group";
    readyRound.teams[0].pureTrackGroupId = 201;
    readyRound.teams[0].pureTrackGroupSlug = "fresh-team-group";
    readyRound.scoring = {
      taskMaxPoints: 1000,
      clubsAttendingCount: 1,
      clubsAttendingFactor: 0.5,
      minDistanceFlightCount: 1,
      minDistanceFactor: 0.5,
      maxPointsForRound: 250,
      maxPilotScoreInRound: 42,
      maxTeamScore: 250,
      maxPilotScoresCountedPerTeam: 4,
      leagueRoundScoresCounted: 6,
      pilotFactors: { "Club Pilot": 1, Pilot: 1, "Advanced Pilot": 1 },
      wingFactors: {
        "EN A": 1,
        "EN B": 1,
        "EN C": 1,
        "EN C 2-liner": 1,
        "EN D": 1,
        "EN D 2-liner": 1,
      },
      teams: [{ teamId: ctx.teamId, workingTeamScore: 250 }],
      scoredAt: "2026-07-13T00:00:00.000Z",
    };
    await writePrivateJson(roundPath, readyRound);
    const readyBrief = await readPrivateJson<RoundBrief>(briefPath);
    if (readyBrief === null) throw new Error("Locked brief was not written");
    readyBrief.pureTrackGroupName = "Fresh round group";
    readyBrief.pureTrackGroupSlug = "fresh-round-group";
    readyBrief.teams[0].pureTrackGroupId = 201;
    readyBrief.teams[0].pureTrackGroupSlug = "fresh-team-group";
    await writePrivateJson(briefPath, readyBrief);
    const frozenHash = readyBrief.hash;
    const scoring = readyRound.scoring;
    const signatureBefore = await readPrivateBytes(signaturePath);

    const res = await unlock(ctx);

    expect(res.status).toBe(200);
    const unlockedRound = await readRequiredRound(ctx.roundId);
    const unlockedBrief = await readPrivateJson<RoundBrief>(briefPath);
    expect(unlockedRound.status).toBe("Confirmed");
    expect(unlockedRound.pureTrack).toBeUndefined();
    expect(unlockedRound.pureTrackGroupId).toBeUndefined();
    expect(unlockedRound.pureTrackGroupName).toBeUndefined();
    expect(unlockedRound.pureTrackGroupSlug).toBeUndefined();
    expect(unlockedRound.teams[0]?.pureTrackGroupId).toBeUndefined();
    expect(unlockedRound.teams[0]?.pureTrackGroupSlug).toBeUndefined();
    expect(unlockedRound.brief?.pdfStatus).toBeUndefined();
    expect(unlockedRound.brief?.pdfAttemptId).toBeUndefined();
    expect(unlockedRound.scoring).toEqual(scoring);
    expect(unlockedBrief?.pureTrackGroupName).toBeUndefined();
    expect(unlockedBrief?.pureTrackGroupSlug).toBeUndefined();
    expect(unlockedBrief?.teams[0]?.pureTrackGroupId).toBeUndefined();
    expect(unlockedBrief?.teams[0]?.pureTrackGroupSlug).toBeUndefined();
    expect(unlockedBrief?.hash).toBe(frozenHash);
    expect(unlockedBrief === null ? undefined : computeBriefHash(unlockedBrief)).toBe(frozenHash);
    expect(await readPrivateBytes(signaturePath)).toEqual(signatureBefore);
  });

  it("restores both blobs when the atomic unlock round write fails", async () => {
    // Given
    const ctx = await seedBriefCompleteRound();
    const briefPath = `round-briefs/${ctx.roundId}.json`;
    const roundPath = `rounds/${ctx.roundId}.json`;
    await writePrivateJson(briefPath, frozenBrief(ctx));
    await lock(ctx);
    const locked = await readRequiredRound(ctx.roundId);
    await setPureTrackStatus(ctx.roundId, "ready", {
      expectAttemptId: locked.pureTrack?.attemptId,
      fromStatuses: ["pending"],
    });
    const readyRound = await readRequiredRound(ctx.roundId);
    readyRound.pureTrackGroupId = 200;
    readyRound.pureTrackGroupName = "Fresh round group";
    readyRound.pureTrackGroupSlug = "fresh-round-group";
    await writePrivateJson(roundPath, readyRound);
    const readyBrief = await readPrivateJson<RoundBrief>(briefPath);
    if (readyBrief === null) throw new Error("Locked brief was not written");
    readyBrief.pureTrackGroupName = "Legacy brief group";
    readyBrief.pureTrackGroupSlug = "legacy-brief-group";
    await writePrivateJson(briefPath, readyBrief);
    const beforeRound = await readPrivateBytes(roundPath);
    const beforeBrief = await readPrivateBytes(briefPath);
    blobWriteControl.sawBriefWrite = false;
    blobWriteControl.failRoundAfterBriefWrite = true;

    // When
    const response = await unlock(ctx);

    // Then
    expect(response.status).toBe(500);
    expect(await readPrivateBytes(roundPath)).toEqual(beforeRound);
    expect(await readPrivateBytes(briefPath)).toEqual(beforeBrief);
  });

  it("keeps the lock and marks PureTrack failed when its enqueue fails", async () => {
    const ctx = await seedBriefCompleteRound();
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, frozenBrief(ctx));
    vi.mocked(enqueuePureTrackGroupJob).mockRejectedValueOnce(new Error("queue unavailable"));

    const res = await lock(ctx);

    expect(res.status).toBe(200);
    const round = await readRequiredRound(ctx.roundId);
    expect(round.status).toBe("Locked");
    expect(round.pureTrack?.status).toBe("failed");
    expect(round.pureTrack?.error).toBe("enqueue_failed");
  });

  it("keeps the lock and marks the PDF failed when enqueue fails", async () => {
    const ctx = await seedBriefCompleteRound();
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, frozenBrief(ctx));
    vi.mocked(enqueueBriefPdf).mockRejectedValueOnce(new Error("queue unavailable"));

    const res = await lock(ctx);

    expect(res.status).toBe(200);
    const round = await readRequiredRound(ctx.roundId);
    expect(round.status).toBe("Locked");
    expect(round.brief?.pdfStatus).toBe("failed");
    expect(round.brief?.pdfError).toBe("enqueue_failed");
    expect(enqueueBriefPdf).toHaveBeenCalledTimes(1);
    expect(pdfMock.generateBriefPdf).not.toHaveBeenCalled();
  });

  it("keeps the lock and still updates the rounds index when both enqueue AND the failure recovery throw", async () => {
    const ctx = await seedBriefCompleteRound();
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, frozenBrief(ctx));
    vi.mocked(enqueueBriefPdf).mockRejectedValueOnce(new Error("queue unavailable"));
    vi.mocked(setBriefPdfStatus).mockRejectedValueOnce(new Error("lease timeout"));

    const res = await lock(ctx);

    expect(res.status).toBe(200);
    expect(enqueueBriefPdf).toHaveBeenCalledTimes(1);
    expect(setBriefPdfStatus).toHaveBeenCalledTimes(1);

    const round = await readRequiredRound(ctx.roundId);
    expect(round.status).toBe("Locked");

    const index = await readPublicJson<Array<{ id: string; status: string }>>("rounds.json");
    const entry = index?.find((r) => r.id === ctx.roundId);
    expect(entry?.status).toBe("Locked");
  });
});
