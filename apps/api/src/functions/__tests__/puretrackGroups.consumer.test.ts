// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Round, RoundBrief } from "@bccweb/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queueMock = vi.hoisted(() => ({ enqueue: vi.fn(), reflect: vi.fn() }));
const rescoreMock = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("../../lib/queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/queue.js")>();
  return {
    ...actual,
    enqueuePureTrackGroupJob: queueMock.enqueue,
    enqueueSignToFlyReflect: queueMock.reflect,
  };
});
vi.mock("../../lib/rescoreJob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/rescoreJob.js")>();
  return { ...actual, enqueueRescore: rescoreMock.enqueue };
});

import { invokeQueue } from "../../__tests__/helpers/api.js";
import {
  privateBlobExists,
  makePilot,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { getRegisteredQueueHandler } from "../../__tests__/helpers/setup.js";
import {
  acquirePureTrackMutationGuard,
  releasePureTrackGuard,
} from "../../lib/puretrackGuard.js";
import "../puretrackGroups.js";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

type SeededJob = { readonly roundId: string; readonly attemptId: string };

function slot(pilotId: string): Round["teams"][number]["pilots"][number] {
  return {
    placeInTeam: 1,
    isScoring: true,
    status: "Filled",
    accountedFor: false,
    signToFly: true,
    noScore: false,
    pilotPoints: 0,
    pilotId,
    snapshot: null,
    flight: null,
  };
}

async function seedJob(): Promise<SeededJob> {
  const roundId = randomUUID();
  const pilot = await makePilot();
  const pilotId = pilot.id;
  const attemptId = randomUUID();
  const round: Round = {
    id: roundId,
    date: "2026-06-09",
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    season: { year: 2026 },
    teams: [{
      id: "team-1",
      teamName: "Alpha",
      club: { id: "club-1", name: "North Club" },
      score: 0,
      pilots: [slot(pilotId)],
      pureTrackGroupId: 11,
      pureTrackGroupSlug: "old-team",
    }],
    pureTrack: { status: "pending", attemptId, updatedAt: new Date().toISOString() },
    pureTrackGroupId: 10,
    pureTrackGroupName: "Old round",
    pureTrackGroupSlug: "old-round",
    scoring: {
      taskMaxPoints: 1000,
      clubsAttendingCount: 1,
      clubsAttendingFactor: 0.5,
      minDistanceFlightCount: 0,
      minDistanceFactor: 0,
      maxPointsForRound: 0,
      maxPilotScoreInRound: 0,
      maxTeamScore: 0,
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
      teams: [],
      scoredAt: "2026-07-13T00:00:00.000Z",
    },
  };
  const brief: RoundBrief = {
    roundId,
    generatedAt: new Date().toISOString(),
    date: round.date,
    siteName: round.site.name,
    teams: [{
      teamName: "Alpha",
      clubName: "North Club",
      pilots: [],
      pureTrackGroupId: 11,
      pureTrackGroupSlug: "old-team",
    }],
    pureTrackGroupName: "Old round",
    pureTrackGroupSlug: "old-round",
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
  await writePrivateJson(`round-briefs/${roundId}.json`, brief);
  await writePrivateJson(`pilots/${pilotId}.json`, { ...pilot, pureTrackId: 123 });
  await writePrivateJson("puretrack-groups/old-round.json", {
    id: "old-round",
    name: "Old round",
    slug: "old-round",
    pilotIds: [pilotId],
    roundId,
    createdAt: new Date().toISOString(),
    externalId: "10",
  });
  await writePrivateJson("puretrack-groups/old-team.json", {
    id: "old-team",
    name: "Old team",
    slug: "old-team",
    pilotIds: [pilotId],
    roundId,
    teamId: "team-1",
    createdAt: new Date().toISOString(),
    externalId: "11",
  });
  await writePrivateJson(`signatures/${roundId}/proof.json`, { signed: true });
  return { roundId, attemptId };
}

function mockSuccessfulUpstream(onImport?: () => Promise<void>): void {
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url.endsWith("/api/login")) {
      return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
    }
    if (url.endsWith("/login")) {
      return new Response('<meta name="csrf-token" content="csrf">', { status: 200 });
    }
    if (url.endsWith("/api/groups?mine=1")) {
      return new Response(JSON.stringify({ data: [
        { id: 10, name: "Old round", slug: "old-round" },
        { id: 11, name: "Old team", slug: "old-team" },
      ] }), { status: 200 });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/api/groups")) {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      const name = JSON.parse(init.body).name as string;
      const id = name.includes("Alpha") ? 21 : 20;
      return new Response(JSON.stringify({ id, name, slug: `group-${id}` }), { status: 200 });
    }
    if (url.endsWith("/import-ids")) {
      await onImport?.();
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected PureTrack request: ${init?.method ?? "GET"} ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env["PURETRACK_ENABLED"] = "true";
  process.env["PURETRACK_API_KEY"] = "key";
  process.env["PURETRACK_EMAIL"] = "test@example.com";
  process.env["PURETRACK_PASSWORD"] = "secret";
});

afterEach(() => {
  delete process.env["PURETRACK_ENABLED"];
  delete process.env["PURETRACK_API_KEY"];
  delete process.env["PURETRACK_EMAIL"];
  delete process.env["PURETRACK_PASSWORD"];
});

describe("pureTrackGroups queue consumer", () => {
  it("deletes recorded groups before replacement and commits the matching attempt ready", async () => {
    const job = await seedJob();
    mockSuccessfulUpstream();

    await invokeQueue("pureTrackGroups", job, { dequeueCount: 1 });

    const methods = fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.indexOf("DELETE")).toBeLessThan(methods.indexOf("POST", 2));
    const round = await readPrivateJson<Round>(`rounds/${job.roundId}.json`);
    expect(round?.pureTrack).toMatchObject({ status: "ready", attemptId: job.attemptId });
    expect(round?.pureTrackGroupId).toBe(20);
    expect(round?.teams[0]?.pureTrackGroupId).toBe(21);
    expect(round?.teams[0]?.pilots[0]?.signToFly).toBe(true);
    expect(round?.scoring?.scoredAt).toBe("2026-07-13T00:00:00.000Z");
    expect(await readPrivateJson(`signatures/${job.roundId}/proof.json`)).toEqual({ signed: true });
    expect(queueMock.reflect).not.toHaveBeenCalled();
    expect(rescoreMock.enqueue).not.toHaveBeenCalled();
    expect(await privateBlobExists("puretrack-groups/old-round.json")).toBe(false);
    expect(await privateBlobExists("puretrack-groups/old-team.json")).toBe(false);
    expect(getRegisteredQueueHandler("pureTrackGroups").queueName).toBe("round-puretrack-group");
  });

  it("ignores a stale attempt without outbound work", async () => {
    const job = await seedJob();

    await invokeQueue("pureTrackGroups", { ...job, attemptId: randomUUID() });

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await readPrivateJson<Round>(`rounds/${job.roundId}.json`))?.pureTrack?.status).toBe("pending");
  });

  it("marks a disabled matching attempt ready without touching echoes or PureTrack", async () => {
    const job = await seedJob();
    process.env["PURETRACK_ENABLED"] = "false";

    await invokeQueue("pureTrackGroups", job);

    const round = await readPrivateJson<Round>(`rounds/${job.roundId}.json`);
    expect(round?.pureTrack?.status).toBe("ready");
    expect(round?.pureTrackGroupId).toBe(10);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-drives an owned processing attempt after redelivery", async () => {
    // Given
    const job = await seedJob();
    const round = await readPrivateJson<Round>(`rounds/${job.roundId}.json`);
    if (round === null) throw new Error("Seeded round disappeared");
    await writePrivateJson(`rounds/${job.roundId}.json`, {
      ...round,
      pureTrack: { ...round.pureTrack, status: "processing" },
    });
    mockSuccessfulUpstream();

    // When
    await invokeQueue("pureTrackGroups", job, { dequeueCount: 2 });

    // Then
    const updated = await readPrivateJson<Round>(`rounds/${job.roundId}.json`);
    expect(updated?.pureTrack).toMatchObject({ status: "ready", attemptId: job.attemptId });
    expect(updated?.pureTrackGroupId).toBe(20);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("reclaims an owned processing attempt when PureTrack is disabled", async () => {
    // Given
    const job = await seedJob();
    const round = await readPrivateJson<Round>(`rounds/${job.roundId}.json`);
    if (round === null) throw new Error("Seeded round disappeared");
    await writePrivateJson(`rounds/${job.roundId}.json`, {
      ...round,
      pureTrack: { ...round.pureTrack, status: "processing" },
    });
    process.env["PURETRACK_ENABLED"] = "false";

    // When
    await invokeQueue("pureTrackGroups", job, { dequeueCount: 2 });

    // Then
    expect((await readPrivateJson<Round>(`rounds/${job.roundId}.json`))?.pureTrack?.status).toBe("ready");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes only invocation-owned groups when the attempt is superseded before commit", async () => {
    const job = await seedJob();
    let importCount = 0;
    mockSuccessfulUpstream(async () => {
      importCount += 1;
      if (importCount !== 2) return;
      const round = await readPrivateJson<Round>(`rounds/${job.roundId}.json`);
      if (round === null) throw new Error("Seeded round disappeared");
      await writePrivateJson(`rounds/${job.roundId}.json`, {
        ...round,
        pureTrack: { status: "pending", attemptId: "replacement", updatedAt: new Date().toISOString() },
      });
    });

    await invokeQueue("pureTrackGroups", job, { dequeueCount: 1 });

    const cleanupUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "DELETE")
      .map(([input]) => input instanceof Request ? input.url : String(input));
    expect(cleanupUrls).toEqual(expect.arrayContaining([
      "https://puretrack.io/api/groups/20",
      "https://puretrack.io/api/groups/21",
    ]));
    const round = await readPrivateJson<Round>(`rounds/${job.roundId}.json`);
    expect(round?.pureTrack).toMatchObject({ status: "pending", attemptId: "replacement" });
    expect(round?.pureTrackGroupId).not.toBe(20);
  });

  it("throws on live guard contention before the final dequeue", async () => {
    const job = await seedJob();
    const owner = await acquirePureTrackMutationGuard("global", "other-attempt");
    if (owner === null) throw new Error("test guard unexpectedly contended");

    await expect(invokeQueue("pureTrackGroups", job, { dequeueCount: 4 })).rejects.toThrow(/guard/i);

    await releasePureTrackGuard(owner);
    expect(queueMock.enqueue).not.toHaveBeenCalled();
  });

  it("delays a fresh copy instead of failing on final-dequeue guard contention", async () => {
    const job = await seedJob();
    const owner = await acquirePureTrackMutationGuard("global", "other-attempt");
    if (owner === null) throw new Error("test guard unexpectedly contended");

    await invokeQueue("pureTrackGroups", job, { dequeueCount: 5 });

    await releasePureTrackGuard(owner);
    expect(queueMock.enqueue).toHaveBeenCalledWith(job, { visibilityTimeoutSeconds: 30 });
    expect((await readPrivateJson<Round>(`rounds/${job.roundId}.json`))?.pureTrack?.status).toBe("pending");
  });

  it("poison fails only the matching pending attempt", async () => {
    const job = await seedJob();

    await invokeQueue("pureTrackGroupsPoison", job);
    await invokeQueue("pureTrackGroupsPoison", { ...job, attemptId: randomUUID() });

    const round = await readPrivateJson<Round>(`rounds/${job.roundId}.json`);
    expect(round?.pureTrack).toMatchObject({ status: "failed", attemptId: job.attemptId, error: "poison" });
    expect(getRegisteredQueueHandler("pureTrackGroupsPoison").queueName).toBe("round-puretrack-group-poison");
  });
});
