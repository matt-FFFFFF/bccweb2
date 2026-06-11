import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { HttpResponseInit } from "@azure/functions";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeRound, makeUser } from "../../__tests__/helpers/seed.js";

const puretrackMock = vi.hoisted(() => ({
  createPureTrackGroups: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../lib/puretrack.js", () => ({
  createPureTrackGroups: puretrackMock.createPureTrackGroups,
}));

import "../puretrack.js";

async function captureEvidence(path: string, res: HttpResponseInit) {
  await mkdir(".omo/evidence", { recursive: true });
  await writeFile(path, JSON.stringify({ status: res.status, jsonBody: res.jsonBody }, null, 2));
}

describe("POST /api/rounds/{id}/puretrack/create-groups scoping", () => {
  it("Admin allowed cross-club", async () => {
    const roundId = randomUUID();
    await makeRound({ id: roundId, status: "Locked", organisingClubId: randomUUID() });
    const { user } = await makeUser({ roles: ["Admin"] });
    const req = makeAuthRequest(user.id, user.email, { method: "POST", params: { id: roundId } });

    const res = await invoke("createPureTrackGroups", req);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toBeNull();
  });

  it("RoundsCoord allowed own club", async () => {
    const clubId = randomUUID();
    const roundId = randomUUID();
    await makeRound({ id: roundId, status: "Locked", organisingClubId: clubId });
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId });
    const req = makeAuthRequest(user.id, user.email, { method: "POST", params: { id: roundId } });

    const res = await invoke("createPureTrackGroups", req);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toBeNull();
    await captureEvidence(".omo/evidence/task-1-own-club-201.txt", res);
  });

  it("RoundsCoord blocked cross-club 403", async () => {
    const roundId = randomUUID();
    await makeRound({ id: roundId, status: "Locked", organisingClubId: randomUUID() });
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: randomUUID() });
    const req = makeAuthRequest(user.id, user.email, { method: "POST", params: { id: roundId } });

    const res = await invoke("createPureTrackGroups", req);

    expect(res.status).toBe(403);
    await captureEvidence(".omo/evidence/task-1-cross-club-403.txt", res);
  });
});
