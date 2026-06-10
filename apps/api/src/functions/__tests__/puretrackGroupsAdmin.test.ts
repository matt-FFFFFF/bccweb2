import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import type { PureTrackGroup } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeUser, makeRound, writePrivateJson } from "../../__tests__/helpers/seed.js";
import "../puretrack.js";

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
