// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import type { PureTrackGroup, Round, RoundBrief } from "@bccweb/types";
import { makeAuthRequest, invoke, invokeQueue } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  makeRound,
  privateBlobExists,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import {
  acquirePureTrackMutationGuard,
  releasePureTrackGuard,
} from "../../lib/puretrackGuard.js";
import * as blobJson from "../../lib/blobJson.js";
import "../puretrack.js";
import "../puretrackGroups.js";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

function mockPureTrack(groups: Array<{ id: number; name: string; slug: string }>): void {
  fetchMock.mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/api/login")) {
      return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
    }
    if (url.endsWith("/login")) {
      return new Response('<meta name="csrf-token" content="csrf">', { status: 200 });
    }
    if (url.endsWith("/api/groups?mine=1")) {
      return new Response(JSON.stringify({ data: groups }), { status: 200 });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env["PURETRACK_API_KEY"] = "key";
  process.env["PURETRACK_EMAIL"] = "admin@example.test";
  process.env["PURETRACK_PASSWORD"] = "secret";
});

afterEach(() => {
  delete process.env["PURETRACK_API_KEY"];
  delete process.env["PURETRACK_EMAIL"];
  delete process.env["PURETRACK_PASSWORD"];
});

async function seedPureTrackGroupBlob(
  overrides: Partial<PureTrackGroup> & { roundId: string }
): Promise<PureTrackGroup> {
  const id = overrides.id ?? randomUUID();
  const record: PureTrackGroup = {
    id,
    name: overrides.name ?? "BCC Test Group",
    slug: overrides.slug ?? "bcc-test-group",
    pilotIds: overrides.pilotIds ?? [],
    roundId: overrides.roundId,
    teamId: overrides.teamId,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    externalId: overrides.externalId ?? "1",
    externalUrl: overrides.externalUrl ?? "https://puretrack.io/group/bcc-test-group",
  };
  await writePrivateJson(`puretrack-groups/${id}.json`, record);
  return record;
}

describe("GET /api/manage/puretrack/groups", () => {
  it("Admin GET groups for roundId -> returns matching groups", async () => {
    const clubId = randomUUID();
    const roundId = randomUUID();
    await makeRound({ id: roundId, organisingClubId: clubId });
    const group = await seedPureTrackGroupBlob({ roundId });
    await seedPureTrackGroupBlob({ roundId: randomUUID() });

    const { user } = await makeUser({ roles: ["Admin"] });
    const req = makeAuthRequest(user.id, user.email, {
      method: "GET",
      query: { roundId },
    });

    const res = await invoke("listPureTrackGroups", req);

    expect(res.status).toBe(200);
    const body = res.jsonBody as PureTrackGroup[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((g) => g.id === group.id)).toBe(true);
    expect(body.every((g) => g.roundId === roundId)).toBe(true);
  });

  it("RoundsCoord scoped to round's club -> returns matching groups", async () => {
    const clubId = randomUUID();
    const roundId = randomUUID();
    await makeRound({ id: roundId, organisingClubId: clubId, organisingClubName: "My Club" });
    const group = await seedPureTrackGroupBlob({ roundId });

    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId });
    const req = makeAuthRequest(user.id, user.email, {
      method: "GET",
      query: { roundId },
    });

    const res = await invoke("listPureTrackGroups", req);

    expect(res.status).toBe(200);
    const body = res.jsonBody as PureTrackGroup[];
    expect(body.some((g) => g.id === group.id)).toBe(true);
  });

  it("RoundsCoord wrong club -> 403", async () => {
    const clubId = randomUUID();
    const roundId = randomUUID();
    await makeRound({ id: roundId, organisingClubId: clubId });
    await seedPureTrackGroupBlob({ roundId });

    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: randomUUID() });
    const req = makeAuthRequest(user.id, user.email, {
      method: "GET",
      query: { roundId },
    });

    const res = await invoke("listPureTrackGroups", req);

    expect(res.status).toBe(403);
  });

  it("Pilot role -> 403", async () => {
    const roundId = randomUUID();
    await makeRound({ id: roundId });

    const { user } = await makeUser({ roles: ["Pilot"] });
    const req = makeAuthRequest(user.id, user.email, {
      method: "GET",
      query: { roundId },
    });

    const res = await invoke("listPureTrackGroups", req);

    expect(res.status).toBe(403);
  });
});

describe("GET /api/manage/puretrack/groups/live", () => {
  it("returns the strict live group array for an Admin", async () => {
    mockPureTrack([{ id: 17, name: "Live group", slug: "live-group" }]);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "listLivePureTrackGroups",
      makeAuthRequest(user.id, user.email, { method: "GET" }),
    );

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual([{ id: 17, name: "Live group", slug: "live-group" }]);
    expect(fetchMock.mock.calls.some(([input]) => {
      const url = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
      return url.endsWith("?mine=1");
    })).toBe(true);
  });

  it("rejects non-Admin callers without outbound work", async () => {
    const { user } = await makeUser({ roles: ["RoundsCoord"] });

    const res = await invoke(
      "listLivePureTrackGroups",
      makeAuthRequest(user.id, user.email, { method: "GET" }),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/manage/puretrack/groups/delete", () => {
  it("rejects non-Admin callers without outbound work", async () => {
    const { user } = await makeUser({ roles: ["RoundsCoord"] });

    const res = await invoke(
      "deletePureTrackGroups",
      makeAuthRequest(user.id, user.email, { method: "POST", body: { ids: [10] } }),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { ids: [] },
    { ids: [1, 1] },
    { ids: ["1"] },
    { ids: Array.from({ length: 201 }, (_, index) => index + 1) },
    { ids: [1], extra: true },
  ])("rejects invalid ids with 400 and no outbound work", async (body) => {
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "deletePureTrackGroups",
      makeAuthRequest(user.id, user.email, { method: "POST", body }),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 409 without outbound work when the global guard is owned", async () => {
    const owner = await acquirePureTrackMutationGuard("global", "consumer-attempt");
    if (owner === null) throw new Error("test guard unexpectedly contended");
    const { user } = await makeUser({ roles: ["Admin"] });

    try {
      const res = await invoke(
        "deletePureTrackGroups",
        makeAuthRequest(user.id, user.email, { method: "POST", body: { ids: [10] } }),
      );

      expect(res.status).toBe(409);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await releasePureTrackGuard(owner);
    }
  });

  it("deletes exact records and echoes while preserving frozen and scoring state", async () => {
    const roundId = randomUUID();
    await makeRound({ id: roundId });
    const round = await readPrivateJson<Round>(`rounds/${roundId}.json`);
    if (round === null) throw new Error("seeded round disappeared");
    round.scoring = {
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
    };
    round.pureTrackGroupId = 10;
    round.pureTrackGroupName = "Round group";
    round.pureTrackGroupSlug = "round-group";
    await writePrivateJson(`rounds/${roundId}.json`, round);
    const brief: RoundBrief = {
      roundId,
      generatedAt: "2026-07-13T00:00:00.000Z",
      date: round.date,
      siteName: round.site.name,
      hash: "frozen-hash",
      pureTrackGroupName: "Round group",
      pureTrackGroupSlug: "round-group",
      teams: [],
    };
    await writePrivateJson(`round-briefs/${roundId}.json`, brief);
    const record = await seedPureTrackGroupBlob({ roundId, externalId: "10" });
    await writePrivateJson(`signatures/${roundId}/proof.json`, { signed: true });
    mockPureTrack([{ id: 10, name: "Round group", slug: "round-group" }]);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "deletePureTrackGroups",
      makeAuthRequest(user.id, user.email, { method: "POST", body: { ids: [10, 99] } }),
    );

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ deleted: 1, alreadyGone: 1 });
    expect(await privateBlobExists(`puretrack-groups/${record.id}.json`)).toBe(false);
    const updatedRound = await readPrivateJson<Round>(`rounds/${roundId}.json`);
    const updatedBrief = await readPrivateJson<RoundBrief>(`round-briefs/${roundId}.json`);
    expect(updatedRound).not.toHaveProperty("pureTrackGroupId");
    expect(updatedRound?.scoring).toEqual(round.scoring);
    expect(updatedBrief?.hash).toBe("frozen-hash");
    expect(await readPrivateJson(`signatures/${roundId}/proof.json`)).toEqual({ signed: true });
  });

  it("clears successful ids before propagating a mid-batch failure", async () => {
    const roundId = randomUUID();
    await makeRound({ id: roundId });
    const round = await readPrivateJson<Round>(`rounds/${roundId}.json`);
    if (round === null) throw new Error("seeded round disappeared");
    round.pureTrackGroupId = 10;
    round.pureTrackGroupName = "Round group";
    round.pureTrackGroupSlug = "round-group";
    await writePrivateJson(`rounds/${roundId}.json`, round);
    await writePrivateJson(`round-briefs/${roundId}.json`, {
      roundId,
      generatedAt: new Date().toISOString(),
      date: round.date,
      siteName: round.site.name,
      pureTrackGroupName: "Round group",
      pureTrackGroupSlug: "round-group",
      teams: [],
    });
    const first = await seedPureTrackGroupBlob({ roundId, externalId: "10" });
    const second = await seedPureTrackGroupBlob({ roundId, externalId: "11" });
    mockPureTrack([
      { id: 10, name: "Round group", slug: "round-group" },
      { id: 11, name: "Other group", slug: "other-group" },
    ]);
    const baseImplementation = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/groups/11") && init?.method === "DELETE") {
        return new Response("failed", { status: 500 });
      }
      if (baseImplementation === undefined) throw new Error("missing PureTrack mock");
      return baseImplementation(input, init);
    });
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "deletePureTrackGroups",
      makeAuthRequest(user.id, user.email, { method: "POST", body: { ids: [10, 11] } }),
    );

    expect(res.status).toBe(500);
    expect(await privateBlobExists(`puretrack-groups/${first.id}.json`)).toBe(false);
    expect(await privateBlobExists(`puretrack-groups/${second.id}.json`)).toBe(true);
    expect(await readPrivateJson<Round>(`rounds/${roundId}.json`)).not.toHaveProperty(
      "pureTrackGroupId",
    );
  });

  it("serializes a consumer behind admin deletion so deleted echoes cannot become ready", async () => {
    const roundId = randomUUID();
    const attemptId = randomUUID();
    await makeRound({ id: roundId });
    const round = await readPrivateJson<Round>(`rounds/${roundId}.json`);
    if (round === null) throw new Error("seeded round disappeared");
    round.pureTrack = { status: "pending", attemptId, updatedAt: new Date().toISOString() };
    round.pureTrackGroupId = 10;
    round.pureTrackGroupName = "Round group";
    round.pureTrackGroupSlug = "round-group";
    await writePrivateJson(`rounds/${roundId}.json`, round);
    await writePrivateJson(`round-briefs/${roundId}.json`, {
      roundId,
      generatedAt: new Date().toISOString(),
      date: round.date,
      siteName: round.site.name,
      pureTrackGroupName: "Round group",
      pureTrackGroupSlug: "round-group",
      teams: [],
    });
    await seedPureTrackGroupBlob({ roundId, externalId: "10" });
    let releaseLogin: ((response: Response) => void) | undefined;
    const loginPending = new Promise<Response>((resolve) => {
      releaseLogin = resolve;
    });
    mockPureTrack([{ id: 10, name: "Round group", slug: "round-group" }]);
    const baseImplementation = fetchMock.getMockImplementation();
    fetchMock.mockImplementationOnce(() => loginPending).mockImplementation(async (input, init) => {
      if (baseImplementation === undefined) throw new Error("missing PureTrack mock");
      return baseImplementation(input, init);
    });
    const { user } = await makeUser({ roles: ["Admin"] });
    const adminDelete = invoke(
      "deletePureTrackGroups",
      makeAuthRequest(user.id, user.email, { method: "POST", body: { ids: [10] } }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await expect(
      invokeQueue("pureTrackGroups", { roundId, attemptId }, { dequeueCount: 1 }),
    ).rejects.toThrow(/guard/i);
    if (releaseLogin === undefined) throw new Error("login resolver was not initialized");
    releaseLogin(new Response(JSON.stringify({ access_token: "token" }), { status: 200 }));
    expect((await adminDelete).status).toBe(200);

    const updated = await readPrivateJson<Round>(`rounds/${roundId}.json`);
    expect(updated).not.toHaveProperty("pureTrackGroupId");
    expect(updated?.pureTrack?.status).toBe("pending");
  });

  it("restores the exact brief state when the compensated round write fails", async () => {
    const roundId = randomUUID();
    await makeRound({ id: roundId });
    const round = await readPrivateJson<Round>(`rounds/${roundId}.json`);
    if (round === null) throw new Error("seeded round disappeared");
    round.pureTrackGroupId = 10;
    round.pureTrackGroupName = "Round group";
    round.pureTrackGroupSlug = "round-group";
    await writePrivateJson(`rounds/${roundId}.json`, round);
    const brief: RoundBrief = {
      roundId,
      generatedAt: new Date().toISOString(),
      date: round.date,
      siteName: round.site.name,
      hash: "rollback-hash",
      pureTrackGroupName: "Round group",
      pureTrackGroupSlug: "round-group",
      teams: [],
    };
    await writePrivateJson(`round-briefs/${roundId}.json`, brief);
    const record = await seedPureTrackGroupBlob({ roundId, externalId: "10" });
    mockPureTrack([{ id: 10, name: "Round group", slug: "round-group" }]);
    const originalWrite = blobJson.writePrivateJson;
    vi.spyOn(blobJson, "writePrivateJson").mockImplementation(
      async (path, schema, data, leaseId, opts) => {
        if (path === `rounds/${roundId}.json`) throw new Error("injected round write failure");
        return originalWrite(path, schema, data, leaseId, opts);
      },
    );
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "deletePureTrackGroups",
      makeAuthRequest(user.id, user.email, { method: "POST", body: { ids: [10] } }),
    );

    expect(res.status).toBe(500);
    expect(await readPrivateJson<RoundBrief>(`round-briefs/${roundId}.json`)).toEqual(brief);
    expect(await readPrivateJson<Round>(`rounds/${roundId}.json`)).toMatchObject({
      pureTrackGroupId: 10,
      pureTrackGroupSlug: "round-group",
    });
    expect(await privateBlobExists(`puretrack-groups/${record.id}.json`)).toBe(true);
  });
});
