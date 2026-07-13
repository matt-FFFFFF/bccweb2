// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpResponseInit } from "@azure/functions";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeRound, makeUser, writePrivateJson } from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";

function randomIp(): string {
  return `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}

vi.mock("../../lib/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queue.js")>()),
  enqueuePureTrackGroupJob: vi.fn(),
}));

import { enqueuePureTrackGroupJob } from "../../lib/queue.js";
import "../puretrack.js";

async function captureEvidence(path: string, res: HttpResponseInit) {
  await mkdir(".omo/evidence", { recursive: true });
  await writeFile(path, JSON.stringify({ status: res.status, jsonBody: res.jsonBody }, null, 2));
}

async function makeIdleLockedRound(roundId: string, organisingClubId: string): Promise<void> {
  const round = await makeRound({ id: roundId, organisingClubId });
  await writePrivateJson(`rounds/${roundId}.json`, {
    ...round,
    status: "Locked",
    isLocked: true,
  });
}

describe("POST /api/rounds/{id}/puretrack/create-groups scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enqueuePureTrackGroupJob).mockResolvedValue(undefined);
  });

  it("Admin allowed cross-club", async () => {
    const roundId = randomUUID();
    await makeIdleLockedRound(roundId, randomUUID());
    const { user } = await makeUser({ roles: ["Admin"] });
    const req = makeAuthRequest(user.id, user.email, { method: "POST", params: { id: roundId } });

    const res = await invoke("createPureTrackGroups", req);

    expect(res.status).toBe(202);
    expect(res.jsonBody).toEqual({ status: "pending" });
    expect(enqueuePureTrackGroupJob).toHaveBeenCalledWith({
      roundId,
      attemptId: expect.any(String),
    });
  });

  it("RoundsCoord allowed own club", async () => {
    const clubId = randomUUID();
    const roundId = randomUUID();
    await makeIdleLockedRound(roundId, clubId);
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId });
    const req = makeAuthRequest(user.id, user.email, { method: "POST", params: { id: roundId } });

    const res = await invoke("createPureTrackGroups", req);

    expect(res.status).toBe(202);
    expect(res.jsonBody).toEqual({ status: "pending" });
    expect(enqueuePureTrackGroupJob).toHaveBeenCalledWith({
      roundId,
      attemptId: expect.any(String),
    });
    await captureEvidence(".omo/evidence/task-1-own-club-202.txt", res);
  });

  it("returns CONFLICT for a Proposed round", async () => {
    const clubId = randomUUID();
    const roundId = randomUUID();
    await makeRound({ id: roundId, status: "Proposed", organisingClubId: clubId });
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId });
    const req = makeAuthRequest(user.id, user.email, { method: "POST", params: { id: roundId } });

    const res = await invoke("createPureTrackGroups", req);

    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "CONFLICT" });
    expect(enqueuePureTrackGroupJob).not.toHaveBeenCalled();
  });

  it("returns PURETRACK_IN_PROGRESS when a job is already pending", async () => {
    const clubId = randomUUID();
    const roundId = randomUUID();
    await makeIdleLockedRound(roundId, clubId);
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId });
    const req = makeAuthRequest(user.id, user.email, { method: "POST", params: { id: roundId } });
    await invoke("createPureTrackGroups", req);

    const res = await invoke("createPureTrackGroups", req);

    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "PURETRACK_IN_PROGRESS" });
    expect(enqueuePureTrackGroupJob).toHaveBeenCalledTimes(1);
  });

  it("RoundsCoord blocked cross-club 403", async () => {
    const roundId = randomUUID();
    await makeIdleLockedRound(roundId, randomUUID());
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: randomUUID() });
    const req = makeAuthRequest(user.id, user.email, { method: "POST", params: { id: roundId } });

    const res = await invoke("createPureTrackGroups", req);

    expect(res.status).toBe(403);
    await captureEvidence(".omo/evidence/task-1-cross-club-403.txt", res);
  });

  it("scope (403) beats rate-limit (429): forbidden cross-club coord, drained heavy bucket", async () => {
    resetAllBuckets();

    const clubA = randomUUID();
    const { user: coordA } = await makeUser({ roles: ["RoundsCoord"], clubId: clubA });

    // Drain coordA's heavy bucket (capacity=5) with 5 own-club POSTs that pass
    // the scope check and consume one token each.
    for (let i = 0; i < 5; i += 1) {
      const ownRoundId = randomUUID();
      await makeIdleLockedRound(ownRoundId, clubA);
      const drainReq = makeAuthRequest(coordA.id, coordA.email, {
        method: "POST",
        params: { id: ownRoundId },
        headers: { "x-forwarded-for": randomIp() },
      });
      const drainRes = await invoke("createPureTrackGroups", drainReq);
      expect(drainRes.status).toBe(202);
    }

    // A round organised by a different club — coordA must not touch it.
    const crossRoundId = randomUUID();
    await makeIdleLockedRound(crossRoundId, randomUUID());

    const req = makeAuthRequest(coordA.id, coordA.email, {
      method: "POST",
      params: { id: crossRoundId },
      headers: { "x-forwarded-for": randomIp() },
    });

    const res = await invoke("createPureTrackGroups", req);

    // 403 (forbiddenResponse) MUST beat 429, and a forbidden caller gets no
    // Retry-After header because no bucket capacity was consumed.
    expect(res.status).toBe(403);
    expect(res.jsonBody).toMatchObject({ error: "Forbidden" });
    const headers = (res.headers ?? {}) as Record<string, string>;
    expect(headers["Retry-After"]).toBeUndefined();
    await captureEvidence(".omo/evidence/task-6-puretrack-403.txt", res);
  });
});
