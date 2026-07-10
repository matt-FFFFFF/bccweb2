// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Round, RoundBrief, Season } from "@bccweb/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import { computeBriefHash } from "../../lib/signTofly/briefVersion.js";

const pureTrackMock = vi.hoisted(() => ({
  createPureTrackGroups: vi.fn(),
}));
vi.mock("../../lib/puretrack.js", () => ({
  createPureTrackGroups: pureTrackMock.createPureTrackGroups,
}));

const pdfMock = vi.hoisted(() => ({
  generateBriefPdf: vi.fn(),
}));
vi.mock("../../lib/pdf.js", () => ({
  generateBriefPdf: pdfMock.generateBriefPdf,
}));

vi.mock("../../lib/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queue.js")>()),
  enqueueBriefPdf: vi.fn(),
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

import { enqueueBriefPdf } from "../../lib/queue.js";
import { setBriefPdfStatus } from "../../lib/briefPdf.js";
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
    version: 1,
    teams: [],
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

describe("lockRound async brief PDF queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pureTrackMock.createPureTrackGroups.mockResolvedValue(null);
    vi.mocked(enqueueBriefPdf).mockResolvedValue(undefined);
    vi.mocked(setBriefPdfStatus).mockImplementation(briefPdfMock.realSetBriefPdfStatus);
  });

  it("enqueues a pending PDF job on lock and clears PDF state on unlock", async () => {
    const ctx = await seedBriefCompleteRound();
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, frozenBrief(ctx));

    const lockRes = await lock(ctx);

    expect(lockRes.status).toBe(200);
    const lockedRound = await readRequiredRound(ctx.roundId);
    expect(lockedRound.status).toBe("Locked");
    expect(lockedRound.brief?.pdfStatus).toBe("pending");
    expect(lockedRound.brief?.pdfAttemptId).toMatch(UUID_RE);
    expect(lockedRound.brief?.pdfUpdatedAt).toBeTruthy();
    expect(enqueueBriefPdf).toHaveBeenCalledTimes(1);
    expect(enqueueBriefPdf).toHaveBeenCalledWith({
      roundId: ctx.roundId,
      briefVersion: lockedRound.brief?.version,
      pdfAttemptId: lockedRound.brief?.pdfAttemptId,
    });
    expect(pdfMock.generateBriefPdf).not.toHaveBeenCalled();

    const unlockRes = await unlock(ctx);

    expect(unlockRes.status).toBe(200);
    const unlockedRound = await readRequiredRound(ctx.roundId);
    expect(unlockedRound.status).toBe("Confirmed");
    expect(unlockedRound.brief?.pdfStatus).toBeUndefined();
    expect(unlockedRound.brief?.pdfAttemptId).toBeUndefined();
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
