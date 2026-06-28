import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Round, RoundBrief, Site } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  makePilot,
  privateBlobExists,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import * as blobModule from "../../lib/blob.js";
import "../roundsMutate.js";

interface SeedCtx {
  roundId: string;
  adminUserId: string;
  adminEmail: string;
}

async function seedProposedRound(): Promise<SeedCtx> {
  const { user } = await makeUser({ roles: ["Admin"] });
  const pilot1 = await makePilot();
  const pilot2 = await makePilot();

  const siteId = randomUUID();
  const site: Site = {
    id: siteId,
    name: "Milk Hill",
    status: "Active",
    clubId: randomUUID(),
    parkingW3W: "filled.count.soap",
    briefingW3W: "brief.count.soap",
    takeOffW3W: "takeoff.count.soap",
    guideUrl: "https://example.com/guide",
  };
  await writePrivateJson(`sites/${siteId}.json`, site);

  const roundId = randomUUID();
  const round: Round = {
    id: roundId,
    date: "2026-07-15",
    status: "Proposed",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    briefingTime: "10:00",
    checkInByTime: "19:00",
    landByTime: "18:00",
    site: {
      id: siteId,
      name: site.name,
      parkingW3W: site.parkingW3W,
      briefingW3W: site.briefingW3W,
      takeOffW3W: site.takeOffW3W,
    },
    organisingClub: { id: randomUUID(), name: "Test Org Club" },
    season: { year: 2026 },
    teams: [
      {
        id: randomUUID(),
        teamName: "Alpha",
        club: { id: randomUUID(), name: "Alpha Club" },
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
            pilotId: pilot1.id,
            snapshot: null,
            flight: null,
          },
          {
            placeInTeam: 2,
            isScoring: false,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            pilotId: pilot2.id,
            snapshot: null,
            flight: null,
          },
        ],
      },
    ],
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);

  return { roundId, adminUserId: user.id, adminEmail: user.email };
}

describe("confirmRound skeleton brief blob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("confirmRound creates round-briefs/{id}.json on first confirm", async () => {
    const ctx = await seedProposedRound();

    const res = await invoke(
      "confirmRound",
      makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
        method: "POST",
        params: { id: ctx.roundId },
      }),
    );

    expect(res.status).toBe(200);
    const round = res.jsonBody as Round;
    expect(round.status).toBe("Confirmed");

    expect(await privateBlobExists(`round-briefs/${ctx.roundId}.json`)).toBe(true);

    const brief = await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`);
    expect(brief).not.toBeNull();
    expect(brief!.roundId).toBe(ctx.roundId);
    expect(brief!.siteName).toBe("Milk Hill");
    expect(brief!.date).toBe("2026-07-15");
    expect(brief!.briefingTime).toBe("10:00");
    expect(brief!.parkingW3W).toBe("filled.count.soap");
    expect(brief!.guideUrl).toBe("https://example.com/guide");
    expect(brief!.organisingClubName).toBe("Test Org Club");
    expect(brief!.teams).toHaveLength(1);
    expect(brief!.teams[0].teamName).toBe("Alpha");
    expect(brief!.teams[0].clubName).toBe("Alpha Club");
    // Pre-lock: snapshots are null so pilots are filtered out by buildRoundBrief.
    expect(brief!.teams[0].pilots).toEqual([]);

    // Narrative fields must be undefined on a skeleton.
    expect(brief!.airspaceAndHazards).toBeUndefined();
    expect(brief!.NOTAMs).toBeUndefined();
    expect(brief!.briefersNotes).toBeUndefined();
    expect(brief!.windSpeedDirection).toBeUndefined();
    expect(brief!.briefer).toBeUndefined();
    expect(brief!.imagePaths).toBeUndefined();
    expect(brief!.version).toBeUndefined();
  });

  it("confirmRound does NOT clobber a pre-existing brief blob (if-none-match defense-in-depth)", async () => {
    const ctx = await seedProposedRound();

    const preExisting: RoundBrief = {
      roundId: ctx.roundId,
      generatedAt: "2025-01-01T00:00:00.000Z",
      date: "2026-07-15",
      siteName: "Original Site Name",
      teams: [],
      airspaceAndHazards: "Test airspace note",
      briefersNotes: "Briefing complete",
    };
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, preExisting);

    const res = await invoke(
      "confirmRound",
      makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
        method: "POST",
        params: { id: ctx.roundId },
      }),
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as Round).status).toBe("Confirmed");

    const brief = await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`);
    expect(brief).not.toBeNull();
    expect(brief!.airspaceAndHazards).toBe("Test airspace note");
    expect(brief!.briefersNotes).toBe("Briefing complete");
    expect(brief!.siteName).toBe("Original Site Name");
  });

  it("confirmRound is best-effort: brief write failure does NOT fail the confirm", async () => {
    const ctx = await seedProposedRound();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalWritePrivateBlob = blobModule.writePrivateBlob;
    const writeSpy = vi
      .spyOn(blobModule, "writePrivateBlob")
      .mockImplementation(async (path, data, leaseId, options) => {
        if (path.startsWith("round-briefs/")) {
          throw new Error("simulated brief write failure");
        }
        return originalWritePrivateBlob(path, data, leaseId, options);
      });

    const res = await invoke(
      "confirmRound",
      makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
        method: "POST",
        params: { id: ctx.roundId },
      }),
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as Round).status).toBe("Confirmed");

    // The round blob update went through originalWritePrivateBlob.
    const persisted = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(persisted?.status).toBe("Confirmed");

    // The brief write was attempted but failed; the failure was logged.
    const briefAttempts = writeSpy.mock.calls.filter(([path]) =>
      String(path).startsWith("round-briefs/"),
    );
    expect(briefAttempts.length).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});
