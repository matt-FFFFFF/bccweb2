// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";
import type {
  Pilot,
  PilotSeasonClub,
  PilotSummary,
  SeasonSummary,
} from "@bccweb/types";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  readPublicJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import "../meProfile.js";

const ctx = { log: () => undefined } as never;
const ACTIVE_YEAR = 2027;

async function invokeCreate(userId: string, email: string, body: Record<string, unknown>) {
  const entry = getRegisteredHandler("createMyPilot");
  if (!entry) throw new Error("createMyPilot not registered");
  const req = makeAuthRequest(userId, email, { method: "POST", body });
  return (await entry.handler(req, ctx)) as { status: number; jsonBody?: unknown };
}

async function seedActiveSeason(): Promise<void> {
  const seasons: SeasonSummary[] = [
    { id: "season-active", year: ACTIVE_YEAR, active: true },
  ];
  await writePublicJson("seasons.json", seasons);
  await writePublicJson("pilots.json", []);
}

async function indexClubId(pilotId: string): Promise<string | undefined> {
  const index = await readPublicJson<PilotSummary[]>("pilots.json");
  return index?.find((p) => p.id === pilotId)?.clubId;
}

async function clubMapEntry(pilotId: string): Promise<string | undefined> {
  const map = await readPrivateJson<Record<string, string>>(
    `seasons/${ACTIVE_YEAR}/pilot-club-map.json`,
  );
  return map?.[pilotId];
}

describe("POST /api/me/pilot — self-selected club becomes the season club (issue #101)", () => {
  test("with currentClub: provisional season club, public clubId, and pilot-club-map all set", async () => {
    await seedActiveSeason();
    const { user } = await makeUser({ roles: [], pilotId: null, emailVerified: true });

    const res = await invokeCreate(user.id, user.email, {
      firstName: "Cleo",
      lastName: "Cloudbase",
      currentClub: { id: "club-101", name: "Cloudbase Club" },
    });

    expect(res.status).toBe(201);
    const created = res.jsonBody as Pilot;

    const stored = await readPrivateJson<Pilot>(`pilots/${created.id}.json`);
    const expectedSeasonClub: PilotSeasonClub = {
      seasonYear: ACTIVE_YEAR,
      clubId: "club-101",
      clubName: "Cloudbase Club",
    };
    expect(stored?.seasonClubs).toEqual([expectedSeasonClub]);
    expect(created.seasonClubs).toEqual([expectedSeasonClub]);

    expect(await indexClubId(created.id)).toBe("club-101");
    expect(await clubMapEntry(created.id)).toBe("club-101");
  });

  test("without currentClub: no season club, public clubId undefined, no map entry", async () => {
    await seedActiveSeason();
    const { user } = await makeUser({ roles: [], pilotId: null, emailVerified: true });

    const res = await invokeCreate(user.id, user.email, {
      firstName: "Sol",
      lastName: "Soarer",
    });

    expect(res.status).toBe(201);
    const created = res.jsonBody as Pilot;

    const stored = await readPrivateJson<Pilot>(`pilots/${created.id}.json`);
    expect(stored?.seasonClubs).toEqual([]);

    expect(await indexClubId(created.id)).toBeUndefined();
    expect(await clubMapEntry(created.id)).toBeUndefined();
  });

  test("map sync failure is non-fatal → still 201 with pilot blob + public index correct", async () => {
    await seedActiveSeason();
    const { user } = await makeUser({ roles: [], pilotId: null, emailVerified: true });

    // Force upsertPilotClubMap to reject by holding a lease on the map blob: its
    // own (non-retrying) withPrivateLease acquire will 409, but the map write is
    // best-effort so the handler must still return 201 with the durable writes done.
    const mapPath = `seasons/${ACTIVE_YEAR}/pilot-club-map.json`;
    const mapBlob = getPrivateContainer().getBlockBlobClient(mapPath);
    await mapBlob.upload("{}", 2, {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
    const lease = mapBlob.getBlobLeaseClient();
    await lease.acquireLease(60);

    try {
      const res = await invokeCreate(user.id, user.email, {
        firstName: "Gale",
        lastName: "Grounded",
        currentClub: { id: "club-map-fail", name: "Mapfail Club" },
      });

      expect(res.status).toBe(201);
      const created = res.jsonBody as Pilot;

      const stored = await readPrivateJson<Pilot>(`pilots/${created.id}.json`);
      expect(stored?.currentClub?.id).toBe("club-map-fail");
      expect(stored?.seasonClubs).toEqual([
        { seasonYear: ACTIVE_YEAR, clubId: "club-map-fail", clubName: "Mapfail Club" },
      ]);
      expect(await indexClubId(created.id)).toBe("club-map-fail");

      // The denormalised map write was skipped (still our leased "{}") — non-fatal.
      expect(await clubMapEntry(created.id)).toBeUndefined();
    } finally {
      await lease.releaseLease();
    }
  });
});
