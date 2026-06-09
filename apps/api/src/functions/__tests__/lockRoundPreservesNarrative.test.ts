import { randomUUID } from "node:crypto";
import type { Pilot, Round, RoundBrief, Season } from "@bccweb/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import {
  makeClub,
  makeConfig,
  makePilot,
  makeSite,
  makeUser,
  readPrivateJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";

// ─── External-service mocks (deterministic + no real I/O) ─────────────────────
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

const emailMock = vi.hoisted(() => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  getBriefRecipients: vi.fn().mockReturnValue([]),
  briefHtmlBody: vi.fn().mockReturnValue("<p>brief</p>"),
  briefPlainText: vi.fn().mockReturnValue("brief"),
}));
vi.mock("../../lib/email.js", () => ({
  sendEmail: emailMock.sendEmail,
  getBriefRecipients: emailMock.getBriefRecipients,
  briefHtmlBody: emailMock.briefHtmlBody,
  briefPlainText: emailMock.briefPlainText,
}));

// Override default 15s renewIntervalMs which hits the leaseDurationSec*500 guard.
vi.mock("../../lib/blob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blob.js")>();
  return {
    ...actual,
    withLeaseRenewing: <T>(
      path: string,
      fn: (leaseId: string) => Promise<T>,
      opts: Parameters<typeof actual.withLeaseRenewing>[2] = {},
    ) => actual.withLeaseRenewing(path, fn, { renewIntervalMs: 1_000, ...opts }),
    withPrivateLeaseRenewing: <T>(
      path: string,
      fn: (leaseId: string) => Promise<T>,
      opts: Parameters<typeof actual.withPrivateLeaseRenewing>[2] = {},
    ) => actual.withPrivateLeaseRenewing(path, fn, { renewIntervalMs: 1_000, ...opts }),
  };
});

// Register handlers (side-effectful import)
import "../roundsMutate.js";

interface Ctx {
  roundId: string;
  teamId: string;
  pilotId: string;
  adminUserId: string;
  adminEmail: string;
  clubId: string;
  siteId: string;
  year: number;
}

async function seedBriefCompleteRound(): Promise<Ctx> {
  const year = 3000 + Math.floor(Math.random() * 6_000);
  const club = await makeClub({ id: randomUUID(), name: "Lock Test Club" });
  const site = await makeSite({ id: randomUUID(), name: "Milk Hill", clubId: club.id });
  await makeConfig({});
  const pilot = await makePilot({
    id: randomUUID(),
    firstName: "Lock",
    lastName: "Pilot",
    clubId: club.id,
  });
  // Patch pilot with snapshot-able fields so lock can take a snapshot.
  const patched: Pilot = {
    ...pilot,
    bhpaNumber: 12345,
    helmetColour: "white",
    harnessType: "pod",
    harnessColour: "black",
    wingManufacturer: { id: randomUUID(), name: "Ozone" },
    wingModel: "Delta",
    wingColours: "blue",
    emergencyContactName: "Emergency Contact",
    emergencyPhoneNumber: "07111222333",
    medicalInfo: "none",
    person: { ...pilot.person, phoneNumber: "07999000111" },
  };
  await writePrivateJson(`pilots/${pilot.id}.json`, patched);
  const { user: admin } = await makeUser({ roles: ["Admin"], clubId: club.id });

  const teamId = randomUUID();
  const roundId = randomUUID();
  const round: Round = {
    id: roundId,
    date: `${year}-06-09`,
    status: "BriefComplete",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    briefingTime: "10:00",
    landByTime: "18:00",
    checkInByTime: "19:00",
    site: {
      id: site.id,
      name: "Milk Hill",
      parkingW3W: "filled.count.soap",
      briefingW3W: "brief.count.soap",
      takeOffW3W: "takeoff.count.soap",
    },
    organisingClub: { id: club.id, name: "Lock Test Club" },
    season: { year },
    teams: [
      {
        id: teamId,
        teamName: "Alpha",
        club: { id: club.id, name: "Lock Test Club" },
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
            pilotId: pilot.id,
            snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
            flight: null,
          },
        ],
      },
    ],
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
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
      siteId: site.id,
      siteName: "Milk Hill",
      status: round.status,
      seasonYear: year,
    },
  ]);

  return {
    roundId,
    teamId,
    pilotId: pilot.id,
    adminUserId: admin.id,
    adminEmail: admin.email,
    clubId: club.id,
    siteId: site.id,
    year,
  };
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

describe("lockRound preserves brief narrative while refreshing derived fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pureTrackMock.createPureTrackGroups.mockResolvedValue(null);
    pdfMock.generateBriefPdf.mockResolvedValue(Buffer.from("%PDF-1.4 lock-test"));
    emailMock.getBriefRecipients.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves narrative fields on existing brief", async () => {
    const ctx = await seedBriefCompleteRound();
    const existing: RoundBrief = {
      roundId: ctx.roundId,
      generatedAt: "2026-06-09T08:00:00.000Z",
      date: `${ctx.year}-06-09`,
      // Derived (should be overwritten by buildRoundBrief):
      siteName: "OLD STALE SITE NAME",
      // Narrative (must be preserved):
      windSpeedDirection: "NW 15kt",
      directionOfFlight: "SW",
      expectedLandingArea: "Field A",
      airspaceAndHazards: "Hazards X",
      NOTAMs: "NOTAMs Y",
      BENO_LineDescription: "Line description",
      briefersNotes: "Notes Z",
      briefer: { name: "Alice", bhpaCoachLevel: "Senior" },
      imagePaths: ["images/abc.jpg", "images/def.jpg"],
      teams: [],
    };
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, existing);

    const res = await lock(ctx);
    expect(res.status).toBe(200);

    const after = (await readPrivateJson<RoundBrief>(
      `round-briefs/${ctx.roundId}.json`,
    ))!;
    expect(after.windSpeedDirection).toBe("NW 15kt");
    expect(after.directionOfFlight).toBe("SW");
    expect(after.expectedLandingArea).toBe("Field A");
    expect(after.airspaceAndHazards).toBe("Hazards X");
    expect(after.NOTAMs).toBe("NOTAMs Y");
    expect(after.BENO_LineDescription).toBe("Line description");
    expect(after.briefersNotes).toBe("Notes Z");
    expect(after.briefer).toEqual({ name: "Alice", bhpaCoachLevel: "Senior" });
    expect(after.imagePaths).toEqual(["images/abc.jpg", "images/def.jpg"]);
    // Derived field should be refreshed from round data:
    expect(after.siteName).toBe("Milk Hill");
  });

  it("refreshes derived fields when round data changed since confirm", async () => {
    const ctx = await seedBriefCompleteRound();
    // Stale brief from confirm time: teams was empty.
    const stale: RoundBrief = {
      roundId: ctx.roundId,
      generatedAt: "2026-06-01T08:00:00.000Z",
      date: `${ctx.year}-06-09`,
      siteName: "Stale Site Name",
      teams: [],
    };
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, stale);

    const res = await lock(ctx);
    expect(res.status).toBe(200);

    const after = (await readPrivateJson<RoundBrief>(
      `round-briefs/${ctx.roundId}.json`,
    ))!;
    // Derived: teams rebuilt from the live round (1 team, 1 pilot now).
    expect(after.teams).toHaveLength(1);
    expect(after.teams[0]!.pilots).toHaveLength(1);
    expect(after.teams[0]!.pilots[0]!.pilotId).toBe(ctx.pilotId);
    expect(after.siteName).toBe("Milk Hill");
  });

  it("preserves version and versionHistory across the merge", async () => {
    const ctx = await seedBriefCompleteRound();
    const v1 = {
      version: 1,
      hash: "hash-v1",
      createdAt: "2026-06-01T00:00:00.000Z",
      createdBy: "admin",
    };
    const v2 = {
      version: 2,
      hash: "hash-v2",
      createdAt: "2026-06-02T00:00:00.000Z",
      createdBy: "admin",
    };
    const existing: RoundBrief = {
      roundId: ctx.roundId,
      generatedAt: "2026-06-09T08:00:00.000Z",
      date: `${ctx.year}-06-09`,
      siteName: "Milk Hill",
      version: 3,
      versionHistory: [v1, v2],
      teams: [],
    };
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, existing);

    const res = await lock(ctx);
    expect(res.status).toBe(200);

    const after = (await readPrivateJson<RoundBrief>(
      `round-briefs/${ctx.roundId}.json`,
    ))!;
    expect(after.version).toBe(3);
    expect(after.versionHistory).toHaveLength(2);
    expect(after.versionHistory?.[0]?.hash).toBe("hash-v1");
    expect(after.versionHistory?.[1]?.hash).toBe("hash-v2");
  });

  it("is best-effort: brief merge failure does NOT fail the lock", async () => {
    const ctx = await seedBriefCompleteRound();
    // Write corrupted JSON so readExistingBriefForLock throws on JSON.parse.
    const corrupt = getPrivateContainer().getBlockBlobClient(
      `round-briefs/${ctx.roundId}.json`,
    );
    const body = "not-valid-json{";
    await corrupt.upload(body, body.length, {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const res = await lock(ctx);

    expect(res.status).toBe(200);
    const round = (await readPrivateJson<Round>(
      `rounds/${ctx.roundId}.json`,
    ))!;
    expect(round.status).toBe("Locked");
    // Warning was logged for the brief merge failure.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Brief artifact/email processing failed"),
      expect.anything(),
    );
  });
});
