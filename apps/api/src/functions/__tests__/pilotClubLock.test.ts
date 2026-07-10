// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";
import type { Pilot, PilotSeasonClub, PilotSummary, SeasonSummary } from "@bccweb/types";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makePilot,
  makeUser,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import "../pilots.js";

const ctx = { log: () => undefined } as never;
const ACTIVE_YEAR = 2025;
const ORIGINAL_SEASON_CLUB: PilotSeasonClub = {
  seasonYear: ACTIVE_YEAR,
  clubId: "club-original",
  clubName: "Original Club",
};

async function invokePut(
  userId: string,
  email: string,
  pilotId: string,
  body: Record<string, unknown>
) {
  const entry = getRegisteredHandler("updatePilot");
  if (!entry) throw new Error("updatePilot not registered");
  const req = makeAuthRequest(userId, email, {
    method: "PUT",
    params: { id: pilotId },
    body,
  });
  return (await entry.handler(req, ctx)) as {
    status: number;
    jsonBody?: unknown;
  };
}

async function seedActiveSeason() {
  const seasons: SeasonSummary[] = [
    { id: "season-active", year: ACTIVE_YEAR, active: true },
  ];
  await writePublicJson("seasons.json", seasons);
}

// "Flown" == present in the public results/{year}.json (written by recompute for
// Complete rounds). The lock reads this exact blob, so seeding it makes the pilot
// count as having flown a scored round that season.
async function seedFlown(pilotId: string, year: number) {
  await writePublicJson(`results/${year}.json`, [
    {
      roundId: "r1",
      date: "2025-06-01",
      siteName: "S",
      teamResults: [
        {
          rank: 1,
          teamName: "T",
          clubName: "C",
          score: 1,
          pilots: [
            {
              pilotId,
              pilotName: "N",
              distance: 10,
              score: 1,
              wingClass: "EN B",
            },
          ],
        },
      ],
    },
  ]);
}

async function seedPilotAtOriginalClub(
  seasonClubs: PilotSeasonClub[]
): Promise<Pilot> {
  const pilot = await makePilot({});
  pilot.currentClub = { id: "club-original", name: "Original Club" };
  pilot.seasonClubs = seasonClubs;
  await writePrivateJson(`pilots/${pilot.id}.json`, pilot);
  return pilot;
}

function activeSeasonClubs(pilot: Pilot | null): PilotSeasonClub[] {
  return (pilot?.seasonClubs ?? []).filter((sc) => sc.seasonYear === ACTIVE_YEAR);
}

async function pilotSummaryClubId(pilotId: string): Promise<string | undefined> {
  const index = (await readPublicJson<PilotSummary[]>("pilots.json")) ?? [];
  return index.find((p) => p.id === pilotId)?.clubId;
}

async function clubMapEntry(pilotId: string): Promise<string | undefined> {
  const map = await readPrivateJson<Record<string, string>>(
    `seasons/${ACTIVE_YEAR}/pilot-club-map.json`
  );
  return map?.[pilotId];
}

describe("PUT /api/pilots/{id} — club change is flown-locked (issue #101)", () => {
  test("non-admin with an active-season seasonClubs entry but NOT flown → 200, club + season club + index + map all updated", async () => {
    await seedActiveSeason();
    const pilot = await seedPilotAtOriginalClub([ORIGINAL_SEASON_CLUB]);
    const { user } = await makeUser({
      roles: ["Pilot"],
      pilotId: pilot.id,
      emailVerified: true,
    });

    const res = await invokePut(user.id, user.email, pilot.id, {
      currentClub: { id: "club-new", name: "New Club" },
    });

    expect(res.status).toBe(200);

    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.currentClub?.id).toBe("club-new");

    // The active-season seasonClubs entry is REPLACED (not appended) with the new club.
    const active = activeSeasonClubs(stored);
    expect(active).toHaveLength(1);
    expect(active[0]?.clubId).toBe("club-new");
    expect(active[0]?.clubName).toBe("New Club");

    expect(await pilotSummaryClubId(pilot.id)).toBe("club-new");
    expect(await clubMapEntry(pilot.id)).toBe("club-new");
  });

  test("non-admin who HAS flown a scored round this season → 409 CLUB_LOCKED, pilot blob unchanged", async () => {
    await seedActiveSeason();
    const pilot = await seedPilotAtOriginalClub([ORIGINAL_SEASON_CLUB]);
    await seedFlown(pilot.id, ACTIVE_YEAR);
    const { user } = await makeUser({
      roles: ["Pilot"],
      pilotId: pilot.id,
      emailVerified: true,
    });

    const res = await invokePut(user.id, user.email, pilot.id, {
      currentClub: { id: "club-new", name: "New Club" },
    });

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("CLUB_LOCKED");

    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.currentClub?.id).toBe("club-original");
    expect(activeSeasonClubs(stored)[0]?.clubId).toBe("club-original");
  });

  test("(G10a) non-admin flown ONLY in a prior season → 200 (lock is year-scoped)", async () => {
    await seedActiveSeason();
    const pilot = await seedPilotAtOriginalClub([]);
    // Flown last season, but nothing for the active year.
    await seedFlown(pilot.id, ACTIVE_YEAR - 1);
    const { user } = await makeUser({
      roles: ["Pilot"],
      pilotId: pilot.id,
      emailVerified: true,
    });

    const res = await invokePut(user.id, user.email, pilot.id, {
      currentClub: { id: "club-new", name: "New Club" },
    });

    expect(res.status).toBe(200);
    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.currentClub?.id).toBe("club-new");
    expect(activeSeasonClubs(stored)[0]?.clubId).toBe("club-new");
  });

  test("(G10b) Admin changing a FLOWN pilot → 200, and the target pilot's season club + map are written in lockstep", async () => {
    await seedActiveSeason();
    const pilot = await seedPilotAtOriginalClub([ORIGINAL_SEASON_CLUB]);
    await seedFlown(pilot.id, ACTIVE_YEAR);
    const { user: admin } = await makeUser({
      roles: ["Admin"],
      emailVerified: true,
    });

    const res = await invokePut(admin.id, admin.email, pilot.id, {
      currentClub: { id: "club-new", name: "New Club" },
    });

    expect(res.status).toBe(200);

    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.currentClub?.id).toBe("club-new");

    const active = activeSeasonClubs(stored);
    expect(active).toHaveLength(1);
    expect(active[0]?.clubId).toBe("club-new");

    expect(await pilotSummaryClubId(pilot.id)).toBe("club-new");
    expect(await clubMapEntry(pilot.id)).toBe("club-new");
  });

  test("(G1) non-admin selecting a club NOT registered for the season, not flown → 200 (self-selected club is UNGATED)", async () => {
    await seedActiveSeason();
    const pilot = await seedPilotAtOriginalClub([]);
    const { user } = await makeUser({
      roles: ["Pilot"],
      pilotId: pilot.id,
      emailVerified: true,
    });

    // No season-clubs/{ACTIVE_YEAR}/club-unregistered.json is ever created.
    const res = await invokePut(user.id, user.email, pilot.id, {
      currentClub: { id: "club-unregistered", name: "Unregistered Club" },
    });

    expect(res.status).toBe(200);
    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.currentClub?.id).toBe("club-unregistered");
    expect(activeSeasonClubs(stored)[0]?.clubId).toBe("club-unregistered");
    expect(await clubMapEntry(pilot.id)).toBe("club-unregistered");
  });

  test("no-op same-club submit while flown → 200 (other fields still update; club id unchanged)", async () => {
    await seedActiveSeason();
    const pilot = await seedPilotAtOriginalClub([ORIGINAL_SEASON_CLUB]);
    await seedFlown(pilot.id, ACTIVE_YEAR);
    const { user } = await makeUser({
      roles: ["Pilot"],
      pilotId: pilot.id,
      emailVerified: true,
    });

    const res = await invokePut(user.id, user.email, pilot.id, {
      currentClub: { id: "club-original", name: "Original Club" },
      helmetColour: "blue",
    });

    expect(res.status).toBe(200);
    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.helmetColour).toBe("blue");
    expect(stored?.currentClub?.id).toBe("club-original");
  });

  test("map sync failure is non-fatal → still 200 with pilot blob + index correct", async () => {
    await seedActiveSeason();
    const pilot = await seedPilotAtOriginalClub([ORIGINAL_SEASON_CLUB]);
    const { user } = await makeUser({
      roles: ["Pilot"],
      pilotId: pilot.id,
      emailVerified: true,
    });

    // Force upsertPilotClubMap to reject by holding a lease on the map blob: its
    // own withPrivateLease acquire will 409, but the handler treats that as
    // best-effort and must still return 200 with the authoritative writes done.
    const mapPath = `seasons/${ACTIVE_YEAR}/pilot-club-map.json`;
    const mapBlob = getPrivateContainer().getBlockBlobClient(mapPath);
    await mapBlob.upload("{}", 2, {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
    const lease = mapBlob.getBlobLeaseClient();
    await lease.acquireLease(60);

    try {
      const res = await invokePut(user.id, user.email, pilot.id, {
        currentClub: { id: "club-new", name: "New Club" },
      });

      expect(res.status).toBe(200);

      // Pilot blob + public index are authoritative and DID update.
      const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
      expect(stored?.currentClub?.id).toBe("club-new");
      expect(activeSeasonClubs(stored)[0]?.clubId).toBe("club-new");
      expect(await pilotSummaryClubId(pilot.id)).toBe("club-new");

      // The denormalised map write was skipped (still our leased "{}") — non-fatal.
      expect(await clubMapEntry(pilot.id)).toBeUndefined();
    } finally {
      await lease.releaseLease();
    }
  });
});
