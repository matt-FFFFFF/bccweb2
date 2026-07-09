// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * End-to-end brief lifecycle integration test (Vitest, NOT real HTTP).
 *
 * Exercises the FULL brief journey via registered API handlers: the brief is
 * seeded at round-create, edited through PUT /brief (read-merge of the editable
 * subset), frozen at brief-complete, signed against the frozen hash, then locked
 * with derived teams refreshed.
 *
 * Brief mutations go through `createRound`, `updateRoundBrief`,
 * `briefCompleteRound`, or `lockRound`. The round (to stamp a lock-time snapshot
 * the roster gate needs) plus other entities (users, pilots, clubs, sites,
 * seasons, wording) ARE seeded directly.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  Pilot,
  Round,
  RoundBrief,
  Season,
  SignToFlyWording,
} from "@bccweb/types";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { invoke, invokeQueue, makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeClub,
  makeClubTeam,
  makeConfig,
  makePilot,
  makeSite,
  makeUser,
  privateBlobExists,
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

vi.mock("../../lib/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queue.js")>()),
  enqueueBriefPdf: vi.fn(),
}));

// CRITICAL: the default 15s renewIntervalMs trips the leaseDurationSec*500
// safety guard in apps/api/src/lib/blob.ts. Forcing 1s keeps lockRound alive
// for the duration of this test. See plan T2 / lockRoundPreservesNarrative.test.ts.
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

// Register handlers (side-effectful imports)
import { enqueueBriefPdf } from "../../lib/queue.js";
import "../roundsMutate.js";
import "../teams.js";
import "../signatures.js";
import "../signaturesReflect.js";
import "../brief.js";

interface E2ECtx {
  year: number;
  clubId: string;
  siteId: string;
  pilotId: string;
  adminUserId: string;
  adminEmail: string;
  pilotUserId: string;
  pilotEmail: string;
}

async function seedBaseEntities(): Promise<E2ECtx> {
  // Scope this test's data to a high random year to avoid collisions with
  // other tests in the same Azurite container.
  const year = 3000 + Math.floor(Math.random() * 6_000);

  const club = await makeClub({ id: randomUUID(), name: "E2E Test Club" });
  await makeClubTeam({ clubId: club.id, clubName: club.name, seasonYear: year, teamName: "Alpha" });
  const site = await makeSite({
    id: randomUUID(),
    name: "Milk Hill",
    clubId: club.id,
  });

  await makeConfig({});

  await writePublicJson(`seasons/${year}.json`, {
    id: `season-${year}`,
    year,
    active: true,
    rounds: [],
    leagueTable: [],
  } satisfies Season);

  // Patch pilot with snapshot-able fields so lockRound can take a snapshot.
  const pilot = await makePilot({
    id: randomUUID(),
    firstName: "E2E",
    lastName: "Pilot",
    clubId: club.id,
  });
  const patched: Pilot = {
    ...pilot,
    bhpaNumber: 654321,
    helmetColour: "red",
    harnessType: "pod",
    harnessColour: "black",
    wingManufacturer: { id: randomUUID(), name: "Ozone" },
    wingModel: "Zeno",
    wingColours: "green/white",
    emergencyContactName: "Emergency Contact",
    emergencyPhoneNumber: "07123456789",
    medicalInfo: "none",
    person: { ...pilot.person, phoneNumber: "07999000111" },
  };
  await writePrivateJson(`pilots/${pilot.id}.json`, patched);

  const { user: admin } = await makeUser({ roles: ["Admin"], clubId: club.id });
  const { user: pilotUser } = await makeUser({
    roles: ["Pilot"],
    pilotId: pilot.id,
    clubId: club.id,
  });

  // Sign-to-fly wording (signOwnSlot reads this).
  const markdown = "Sign to fly wording";
  await writePrivateJson("sign-to-fly/wording/1.json", {
    version: 1,
    hash: createHash("sha256").update(markdown, "utf8").digest("hex"),
    markdown,
    createdAt: new Date().toISOString(),
    createdBy: "vitest",
  } satisfies SignToFlyWording);
  await writePrivateJson("sign-to-fly/wording/active.json", { activeVersion: 1 });

  return {
    year,
    clubId: club.id,
    siteId: site.id,
    pilotId: pilot.id,
    adminUserId: admin.id,
    adminEmail: admin.email,
    pilotUserId: pilotUser.id,
    pilotEmail: pilotUser.email,
  };
}

describe("brief lifecycle end-to-end via API handlers (no direct brief blob writes)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pureTrackMock.createPureTrackGroups.mockResolvedValue({
      roundGroupId: 999,
      roundGroupName: "E2E Group",
      roundGroupSlug: "e2e-group",
      teams: [],
    });
    pdfMock.generateBriefPdf.mockResolvedValue(Buffer.from("%PDF-1.4 e2e"));
    vi.mocked(enqueueBriefPdf).mockResolvedValue(undefined);
    emailMock.getBriefRecipients.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("create seeds brief -> PUT /brief edit -> brief-complete freezes -> sign -> lock refreshes derived", async () => {
    const base = await seedBaseEntities();

    const createRes = await invoke(
      "createRound",
      makeAuthRequest(base.adminUserId, base.adminEmail, {
        method: "POST",
        body: {
          date: `${base.year}-06-09`,
          siteId: base.siteId,
          seasonYear: base.year,
          organisingClubId: base.clubId,
          briefingTime: "10:00",
          landByTime: "18:00",
          checkInByTime: "19:00",
        },
      }),
    );
    expect(createRes.status).toBe(201);
    const roundId = (createRes.jsonBody as Round).id;
    // Brief is seeded at round-create, not at confirm.
    expect(await privateBlobExists(`round-briefs/${roundId}.json`)).toBe(true);

    const addTeamRes = await invoke(
      "addTeam",
      makeAuthRequest(base.adminUserId, base.adminEmail, {
        method: "POST",
        params: { id: roundId },
        body: { clubId: base.clubId, teamName: "Alpha" },
      }),
    );
    expect(addTeamRes.status).toBe(200);
    const teamId = ((addTeamRes.jsonBody as Round).teams[0]).id;

    const addPilotRes = await invoke(
      "addPilot",
      makeAuthRequest(base.adminUserId, base.adminEmail, {
        method: "POST",
        params: { id: roundId, teamId },
        body: { pilotId: base.pilotId, isScoring: true },
      }),
    );
    expect(addPilotRes.status).toBe(200);

    // Filled slots need a snapshot to pass brief-complete's roster gate.
    const roundForSnapshot = (await readPrivateJson<Round>(`rounds/${roundId}.json`))!;
    for (const team of roundForSnapshot.teams) {
      for (const slot of team.pilots) {
        if (slot.status === "Filled" && slot.pilotId) slot.snapshot = { wingClass: "EN B", pilotRating: "Pilot" };
      }
    }
    await writePrivateJson(`rounds/${roundId}.json`, roundForSnapshot);

    const confirmRes = await invoke(
      "confirmRound",
      makeAuthRequest(base.adminUserId, base.adminEmail, {
        method: "POST",
        params: { id: roundId },
      }),
    );
    expect(confirmRes.status).toBe(200);
    expect((confirmRes.jsonBody as Round).status).toBe("Confirmed");

    const getRes1 = await invoke(
      "getRoundBrief",
      makeAuthRequest(base.adminUserId, base.adminEmail, {
        method: "GET",
        params: { id: roundId },
      }),
    );
    expect(getRes1.status).toBe(200);
    const brief1 = getRes1.jsonBody as RoundBrief;
    expect(brief1.briefingTime).toBe("10:00");
    expect(brief1.hash).toBeUndefined();
    expect(brief1.airspaceAndHazards).toBeUndefined();

    const putRes = await invoke(
      "updateRoundBrief",
      makeAuthRequest(base.adminUserId, base.adminEmail, {
        method: "PUT",
        params: { id: roundId },
        body: {
          airspaceAndHazards: "E2E test airspace",
          briefersNotes: "E2E briefer notes",
          briefer: { name: "E2E Briefer" },
        },
      }),
    );
    expect(putRes.status).toBe(200);
    expect((putRes.jsonBody as RoundBrief).airspaceAndHazards).toBe("E2E test airspace");

    const briefCompleteRes = await invoke(
      "briefCompleteRound",
      makeAuthRequest(base.adminUserId, base.adminEmail, {
        method: "POST",
        params: { id: roundId },
      }),
    );
    expect(briefCompleteRes.status).toBe(200);
    expect((briefCompleteRes.jsonBody as Round).status).toBe("BriefComplete");
    const frozenBrief = (await readPrivateJson<RoundBrief>(`round-briefs/${roundId}.json`))!;
    expect(frozenBrief.hash).toBeTruthy();
    expect(frozenBrief.teams).toHaveLength(1);

    const signRes = await invoke(
      "signOwnSlot",
      makeAuthRequest(base.pilotUserId, base.pilotEmail, {
        method: "POST",
        params: { roundId, teamId, place: "1" },
        headers: {
          "x-forwarded-for": "203.0.113.42, 10.0.0.1",
          "user-agent": "brief-lifecycle-e2e",
        },
      }),
    );
    expect(signRes.status).toBe(201);
    await invokeQueue("signToFlyReflect", { roundId }, {});
    const roundAfterSign = await readPrivateJson<Round>(`rounds/${roundId}.json`);
    expect(roundAfterSign?.teams[0]?.pilots[0]?.signToFly).toBe(true);

    const lockRes = await invoke(
      "lockRound",
      makeAuthRequest(base.adminUserId, base.adminEmail, {
        method: "POST",
        params: { id: roundId },
      }),
    );
    expect(lockRes.status).toBe(200);
    const lockedRound = (await readPrivateJson<Round>(`rounds/${roundId}.json`))!;
    expect(lockedRound.status).toBe("Locked");
    expect(lockedRound.brief?.pdfStatus).toBe("pending");
    expect(lockedRound.brief?.pdfAttemptId).toBeTruthy();
    expect(enqueueBriefPdf).toHaveBeenCalledTimes(1);
    expect(enqueueBriefPdf).toHaveBeenCalledWith({
      roundId,
      briefVersion: lockedRound.brief?.version,
      pdfAttemptId: lockedRound.brief?.pdfAttemptId,
    });
    expect(pdfMock.generateBriefPdf).not.toHaveBeenCalled();
    expect(emailMock.sendEmail).not.toHaveBeenCalled();
    expect(await privateBlobExists(`round-briefs/${roundId}.pdf`)).toBe(false);

    const getRes2 = await invoke(
      "getRoundBrief",
      makeAuthRequest(base.adminUserId, base.adminEmail, {
        method: "GET",
        params: { id: roundId },
      }),
    );
    expect(getRes2.status).toBe(200);
    const brief2 = getRes2.jsonBody as RoundBrief;
    // Edits preserved across brief-complete + lock; derived teams rebuilt.
    expect(brief2.airspaceAndHazards).toBe("E2E test airspace");
    expect(brief2.briefersNotes).toBe("E2E briefer notes");
    expect(brief2.teams).toHaveLength(1);
    expect(brief2.teams[0]?.pilots?.[0]?.snapshot).toBeTruthy();
  });
});
