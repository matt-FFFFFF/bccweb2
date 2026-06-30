import { createHash, randomUUID } from "node:crypto";
import { BlobClient } from "@azure/storage-blob";
import type {
  Pilot,
  Round,
  RoundBrief,
  Season,
  SeasonResults,
  Signature,
  SignToFlyWording,
} from "@bccweb/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { getPrivateContainer, getPublicContainer } from "../../__tests__/helpers/azurite.js";
import {
  makeClub,
  makeClubTeam,
  makeConfig,
  makePilot,
  makeSite,
  makeUser,
  privateBlobExists,
  publicBlobExists,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import { signaturePath } from "../../lib/signTofly/ledger.js";

const pureTrackMock = vi.hoisted(() => ({
  createPureTrackGroups: vi.fn(),
}));

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

import { getBriefRecipients, sendEmail } from "../../lib/email.js";
import { recomputeSeason } from "../../lib/recompute.js";
import "../roundsMutate.js";
import "../teams.js";
import "../signatures.js";
import "../brief.js";

describe("round lifecycle integration", () => {
  const restoredSpies: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    pureTrackMock.createPureTrackGroups.mockResolvedValue({
      roundGroupId: 701,
      roundGroupName: "BCC Milk Hill Tue 09 Jun 26",
      roundGroupSlug: "bcc-milk-hill",
      teams: [],
    });
    pdfMock.generateBriefPdf.mockResolvedValue(Buffer.from("%PDF-1.4 lifecycle"));
    vi.mocked(getBriefRecipients).mockReturnValue([]);
  });

  afterEach(() => {
    while (restoredSpies.length) restoredSpies.pop()?.();
    vi.restoreAllMocks();
  });

  it("happy path create -> confirm -> brief-complete -> sign -> lock generates artifacts and freezes brief metadata", async () => {
    vi.mocked(getBriefRecipients).mockReturnValue(["ops@example.com"]);
    const ctx = await seedCreatedRoundViaHandlers();
    await seedBrief(ctx, { windSpeedDirection: "W 10kt" });

    await expect(statusTransition("confirmRound", ctx)).resolves.toMatchObject({ status: 200 });
    await expect(statusTransition("briefCompleteRound", ctx)).resolves.toMatchObject({ status: 200 });

    const signRes = await signOwnSlot(ctx);
    expect(signRes.status).toBe(201);
    const signedBeforeLock = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(signedBeforeLock?.teams[0].pilots[0].signToFly).toBe(true);

    const lockRes = await lockRound(ctx);

    expect(lockRes.status).toBe(200);
    expect(pureTrackMock.createPureTrackGroups).toHaveBeenCalledTimes(1);
    expect(pdfMock.generateBriefPdf).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await privateBlobExists(`round-briefs/${ctx.roundId}.pdf`)).toBe(true);
    expect(await privateBlobExists(`round-briefs/${ctx.roundId}.json`)).toBe(true);
    const locked = (await readPrivateJson<Round & { brief?: { version?: number; pdfPath?: string } }>(`rounds/${ctx.roundId}.json`))!;
    expect(locked.status).toBe("Locked");
    expect(locked.brief?.version).toBe(1);
    expect(locked.brief?.pdfPath).toBe(`round-briefs/${ctx.roundId}.pdf`);
    expect(await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, 1))).toMatchObject({
      pilotId: ctx.pilotId,
      source: "pilot-self",
    });
  });

  it("completeRound flips Complete and T11 recompute updates season, results, rounds index with no tmp after success", async () => {
    const ctx = await seedLockedScorableRound();

    const completeRes = await completeRound(ctx);
    await waitForPublicBlob(`results/${ctx.year}.json`);

    expect(completeRes.status).toBe(200);
    const completed = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(completed?.status).toBe("Complete");
    const season = (await readPublicJson<Season>(`seasons/${ctx.year}.json`))!;
    const results = (await readPublicJson<SeasonResults>(`results/${ctx.year}.json`))!;
    const roundsIndex = (await readPublicJson<Array<{ id: string; status: string }>>("rounds.json"))!;
    expect(season.rounds).toContain(ctx.roundId);
    expect(season.leagueTable.length).toBeGreaterThan(0);
    expect(results.some((result) => result.roundId === ctx.roundId)).toBe(true);
    expect(roundsIndex.find((round) => round.id === ctx.roundId)?.status).toBe("Complete");
    await expect(publicBlobExists(`seasons/${ctx.year}.json.tmp`)).resolves.toBe(false);
    await expect(publicBlobExists(`results/${ctx.year}.json.tmp`)).resolves.toBe(false);
    await expect(publicBlobExists("rounds.json.tmp")).resolves.toBe(false);
  });

  it("lockRound when status is not BriefComplete returns 409 INVALID_STATE-style conflict", async () => {
    const ctx = await seedLifecycleRound({ status: "Confirmed" });

    const res = await lockRound(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string; error?: string }).code).toBe("CONFLICT");
    expect((res.jsonBody as { error?: string }).error).toBe("Conflict");
  });

  it("completeRound when status is not Locked returns 409 INVALID_STATE-style conflict", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });

    const res = await completeRound(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string; error?: string }).code).toBe("CONFLICT");
    expect((res.jsonBody as { error?: string }).error).toBe("Conflict");
  });

  it("brief edit when round is Locked returns 409 BRIEF_LOCKED", async () => {
    const ctx = await seedLifecycleRound({ status: "Locked", isLocked: true });
    await seedBrief(ctx);

    const res = await updateBrief(ctx, makeBrief(ctx, { siteName: "Cosmetic" }));

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("BRIEF_LOCKED");
  });

  it("brief cosmetic edit in BriefComplete preserves signatures and signToFly", async () => {
    const ctx = await seedSignedBriefCompleteRound();
    const before = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;

    const res = await updateBrief(ctx, makeBrief(ctx, { siteName: "Cosmetic Site Name" }));

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ materialChanged: false, invalidatedSignatureCount: 0 });
    expect((res.jsonBody as { brief: RoundBrief }).brief.version).toBe(1);
    const after = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    expect(before.teams[0].pilots[0].signToFly).toBe(true);
    expect(after.teams[0].pilots[0].signToFly).toBe(true);
    expect(await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, 1))).not.toBeNull();
  });

  it("brief material edit in BriefComplete bumps version, invalidates affected signToFly, preserves signature blob", async () => {
    const ctx = await seedSignedBriefCompleteRound();
    const originalSig = await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, 1));

    const res = await updateBrief(ctx, makeBrief(ctx, { NOTAMs: "New material NOTAM" }));

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ materialChanged: true, invalidatedSignatureCount: 1 });
    expect((res.jsonBody as { brief: RoundBrief }).brief.version).toBe(2);
    const round = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    expect(round.teams[0].pilots[0].signToFly).toBe(false);
    expect(await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, 1))).toEqual(originalSig);
  });

  it("double-lock race allows exactly one lock to succeed", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });
    await seedBrief(ctx);

    const settled = await Promise.allSettled([lockRound(ctx), lockRound(ctx)]);

    const statuses = settled.map((result) => result.status === "fulfilled" ? result.value.status : 500);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status !== 200)).toHaveLength(1);
    const locked = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(locked?.status).toBe("Locked");
  });

  it("recompute crash leaves prior final blob intact, tmp present, and rerun succeeds", async () => {
    const ctx = await seedLockedScorableRound({ complete: true });
    const prior: Season = { id: `season-${ctx.year}`, year: ctx.year, active: true, rounds: [ctx.roundId], leagueTable: [] };
    await writePublicJson(`seasons/${ctx.year}.json`, prior);
    const original = BlobClient.prototype.beginCopyFromURL;
    vi.spyOn(BlobClient.prototype, "beginCopyFromURL").mockImplementationOnce(function (this: BlobClient, source, options) {
      if (this.name === `seasons/${ctx.year}.json`) throw new Error("copy failed after tmp write");
      return original.call(this, source, options);
    });
    restoredSpies.push(() => vi.restoreAllMocks());

    await expect(recomputeSeason(ctx.year)).rejects.toThrow("copy failed after tmp write");
    await expect(readPublicJson<Season>(`seasons/${ctx.year}.json`)).resolves.toEqual(prior);
    await expect(publicBlobExists(`seasons/${ctx.year}.json.tmp`)).resolves.toBe(true);

    vi.restoreAllMocks();
    await recomputeSeason(ctx.year);
    const season = (await readPublicJson<Season>(`seasons/${ctx.year}.json`))!;
    expect(season.leagueTable.length).toBeGreaterThan(0);
    await expect(publicBlobExists(`seasons/${ctx.year}.json.tmp`)).resolves.toBe(false);
  });

  it("recomputeSeason is deterministic across repeated runs", async () => {
    const ctx = await seedLockedScorableRound({ complete: true });

    await recomputeSeason(ctx.year);
    const first = await readPublicBytes(`seasons/${ctx.year}.json`);
    await recomputeSeason(ctx.year);
    const second = await readPublicBytes(`seasons/${ctx.year}.json`);

    expect(Buffer.compare(first, second)).toBe(0);
  });

  it("pilot signs own slot with all audit fields and canonical private path", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });
    await seedBrief(ctx);

    const res = await signOwnSlot(ctx);

    expect(res.status).toBe(201);
    const sig = (await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, 1)))!;
    expect(sig).toMatchObject({
      roundId: ctx.roundId,
      teamId: ctx.teamId,
      place: 1,
      pilotId: ctx.pilotId,
      userId: ctx.pilotUserId,
      briefVersion: 1,
      wordingVersion: 1,
      ip: "203.0.113.42",
      userAgent: "round-lifecycle-test",
      source: "pilot-self",
    });
    expect(sig.id).toBeTruthy();
    expect(sig.signedAt).toBeTruthy();
    expect(sig.briefHash).toBeTruthy();
    expect(sig.wordingHash).toBeTruthy();
  });

  it("pilot signing another pilot's slot returns 403 NOT_YOUR_SLOT", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });
    await seedBrief(ctx);
    const otherPilotId = randomUUID();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: otherPilotId });

    const res = await signOwnSlot(ctx, { userId: user.id, email: user.email });

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("NOT_YOUR_SLOT");
  });

  it("coordinator override with reason at least 20 chars writes coord-override signature and audit log", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });
    await seedBrief(ctx);

    const res = await overrideSign(ctx, "Pilot completed a paper declaration at launch");

    expect(res.status).toBe(201);
    expect(res.jsonBody).toMatchObject({
      source: "coord-override",
      overrideBy: ctx.adminUserId,
      overrideReason: "Pilot completed a paper declaration at launch",
    });
    const audit = await readAuditLines();
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: (res.jsonBody as Signature).id,
        source: "coord-override",
        audit: expect.objectContaining({ signaturePath: expect.stringContaining("-override-") }),
      }),
    ]));
  });

  it("coordinator override with short reason returns 400 INVALID_REASON", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });
    await seedBrief(ctx);

    const res = await overrideSign(ctx, "too short");

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("INVALID_REASON");
  });

  it("PureTrack failure during lock writes no group blob and lock still succeeds", async () => {
    pureTrackMock.createPureTrackGroups.mockRejectedValueOnce(new Error("PureTrack unavailable"));
    const ctx = await seedLifecycleRound({ status: "BriefComplete", pilotPureTrackId: 12345 });
    await seedBrief(ctx);

    const res = await lockRound(ctx);
    const pureTrackBlobs = await listPrivateBlobNames("puretrack-groups/");

    expect(res.status).toBe(200);
    expect(pureTrackMock.createPureTrackGroups).toHaveBeenCalledTimes(1);
    expect(pureTrackBlobs).not.toEqual(expect.arrayContaining([expect.stringContaining(ctx.roundId)]));
    expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status).toBe("Locked");
  });
});

interface LifecycleContext {
  year: number;
  roundId: string;
  teamId: string;
  clubId: string;
  siteId: string;
  pilotId: string;
  adminUserId: string;
  adminEmail: string;
  pilotUserId: string;
  pilotEmail: string;
}

async function seedCreatedRoundViaHandlers(): Promise<LifecycleContext> {
  const base = await seedBaseEntities();
  const createRes = await invoke("createRound", makeAuthRequest(base.adminUserId, base.adminEmail, {
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
  }));
  expect(createRes.status).toBe(201);
  const roundId = (createRes.jsonBody as Round).id;

  const addTeamRes = await invoke("addTeam", makeAuthRequest(base.adminUserId, base.adminEmail, {
    method: "POST",
    params: { id: roundId },
    body: { clubId: base.clubId, teamName: "Alpha" },
  }));
  expect(addTeamRes.status).toBe(200);
  const teamId = ((addTeamRes.jsonBody as Round).teams[0]).id;

  const addPilotRes = await invoke("addPilot", makeAuthRequest(base.adminUserId, base.adminEmail, {
    method: "POST",
    params: { id: roundId, teamId },
    body: { pilotId: base.pilotId, isScoring: true },
  }));
  expect(addPilotRes.status).toBe(200);

  return { ...base, roundId, teamId };
}

async function seedLifecycleRound(opts: {
  status?: Round["status"];
  isLocked?: boolean;
  pilotPureTrackId?: number;
  flightDistance?: number;
  complete?: boolean;
} = {}): Promise<LifecycleContext> {
  const base = await seedBaseEntities({ pilotPureTrackId: opts.pilotPureTrackId });
  const teamId = randomUUID();
  const roundId = randomUUID();
  const status = opts.complete ? "Complete" : opts.status ?? "BriefComplete";
  const round: Round = {
    id: roundId,
    date: `${base.year}-06-09`,
    status,
    isLocked: opts.isLocked ?? status === "Locked",
    maxTeams: 8,
    minimumScore: 0,
    briefingTime: "10:00",
    landByTime: "18:00",
    checkInByTime: "19:00",
    site: { id: base.siteId, name: "Milk Hill", parkingW3W: "filled.count.soap", briefingW3W: "brief.count.soap", takeOffW3W: "takeoff.count.soap" },
    organisingClub: { id: base.clubId, name: "Test Club" },
    season: { year: base.year },
    teams: [{
      id: teamId,
      teamName: "Alpha",
      club: { id: base.clubId, name: "Test Club" },
      score: 0,
      pilots: [{
        placeInTeam: 1,
        isScoring: true,
        status: "Filled",
        accountedFor: status === "Complete",
        signToFly: status === "Complete" || status === "Locked",
        noScore: false,
        pilotPoints: opts.complete ? opts.flightDistance ?? 42 : 0,
        pilotId: base.pilotId,
        snapshot: status === "Locked" || status === "Complete" ? { wingClass: "EN B", pilotRating: "Pilot" } : null,
        flight: status === "Locked" || status === "Complete" ? {
          id: randomUUID(),
          distance: opts.flightDistance ?? 42,
          scoringType: "XC",
          score: 0,
          wingFactor: 1,
          isManualLog: false,
        } : null,
      }],
    }],
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
  await writePublicJson(`seasons/${base.year}.json`, {
    id: `season-${base.year}`,
    year: base.year,
    active: true,
    rounds: [roundId],
    leagueTable: [],
  } satisfies Season);
  await writePublicJson("rounds.json", [{
    id: roundId,
    date: round.date,
    siteId: base.siteId,
    siteName: "Milk Hill",
    status: round.status,
    seasonYear: base.year,
  }]);
  return { ...base, roundId, teamId };
}

async function seedBaseEntities(opts: { pilotPureTrackId?: number } = {}) {
  const year = 3000 + Math.floor(Math.random() * 6_000);
  const club = await makeClub({ id: randomUUID(), name: "Test Club" });
  await makeClubTeam({ clubId: club.id, clubName: club.name, seasonYear: year, teamName: "Alpha" });
  const site = await makeSite({ id: randomUUID(), name: "Milk Hill", clubId: club.id });
  await writePublicJson(`seasons/${year}.json`, { id: `season-${year}`, year, active: true, rounds: [], leagueTable: [] } satisfies Season);
  await makeConfig({
    wingFactors: {
      "EN A": 1,
      "EN B": 1,
      "EN C": 1,
      "EN C 2-liner": 1,
      "EN D": 1,
      "EN D 2-liner": 1,
    },
  });
  const pilot = await makePilot({ id: randomUUID(), firstName: "Lifecycle", lastName: "Pilot", clubId: club.id });
  const patchedPilot: Pilot = {
    ...pilot,
    pureTrackId: opts.pilotPureTrackId ?? 1234,
    bhpaNumber: 123456,
    helmetColour: "white",
    harnessType: "pod",
    harnessColour: "black",
    wingManufacturer: { id: randomUUID(), name: "Ozone" },
    wingModel: "Delta",
    wingColours: "blue",
    emergencyContactName: "Emergency Contact",
    emergencyPhoneNumber: "07123456789",
    medicalInfo: "none",
    person: { ...pilot.person, phoneNumber: "07999111222" },
  };
  await writePrivateJson(`pilots/${pilot.id}.json`, patchedPilot);
  await writePublicJson("pilots.json", [{ id: pilot.id, name: pilot.person.fullName, bhpaNumber: 123456, pureTrackId: patchedPilot.pureTrackId }]);
  const { user: admin } = await makeUser({ roles: ["Admin"], clubId: club.id });
  const { user: pilotUser } = await makeUser({ roles: ["Pilot"], pilotId: pilot.id, clubId: club.id });
  await seedWording();
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

async function seedLockedScorableRound(opts: { complete?: boolean } = {}): Promise<LifecycleContext> {
  return seedLifecycleRound({ status: opts.complete ? "Complete" : "Locked", isLocked: !opts.complete, complete: opts.complete, flightDistance: 42 });
}

async function seedSignedBriefCompleteRound(): Promise<LifecycleContext> {
  const ctx = await seedLifecycleRound({ status: "BriefComplete" });
  await seedBrief(ctx);
  const signRes = await signOwnSlot(ctx);
  expect(signRes.status).toBe(201);
  return ctx;
}

async function seedWording(): Promise<void> {
  const html = "<p>Sign to fly wording</p>";
  await writePrivateJson("sign-to-fly/wording/1.json", {
    version: 1,
    hash: createHash("sha256").update(html, "utf8").digest("hex"),
    html,
    plainText: "Sign to fly wording",
    createdAt: new Date().toISOString(),
    createdBy: "vitest",
  } satisfies SignToFlyWording);
  await writePrivateJson("sign-to-fly/wording/active.json", { activeVersion: 1 });
}

async function seedBrief(ctx: LifecycleContext, overrides: Partial<RoundBrief> = {}): Promise<void> {
  await writePrivateJson(`round-briefs/${ctx.roundId}.json`, makeBrief(ctx, overrides));
}

function makeBrief(ctx: LifecycleContext, overrides: Partial<RoundBrief> = {}): RoundBrief & { version: number } {
  return {
    roundId: ctx.roundId,
    version: 1,
    generatedAt: "2026-06-09T08:00:00.000Z",
    date: `${ctx.year}-06-09`,
    siteName: "Milk Hill",
    parkingW3W: "filled.count.soap",
    briefingW3W: "brief.count.soap",
    takeOffW3W: "takeoff.count.soap",
    briefingTime: "10:00",
    landByTime: "18:00",
    checkInByTime: "19:00",
    windSpeedDirection: "W 10kt",
    teams: [],
    ...overrides,
  };
}

function statusTransition(handler: "confirmRound" | "briefCompleteRound", ctx: LifecycleContext) {
  return invoke(handler, makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "POST",
    params: { id: ctx.roundId },
  }));
}

function lockRound(ctx: LifecycleContext) {
  return invoke("lockRound", makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "POST",
    params: { id: ctx.roundId },
  }));
}

function completeRound(ctx: LifecycleContext) {
  return invoke("completeRound", makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "POST",
    params: { id: ctx.roundId },
  }));
}

function signOwnSlot(ctx: LifecycleContext, caller: { userId: string; email: string } = { userId: ctx.pilotUserId, email: ctx.pilotEmail }) {
  return invoke("signOwnSlot", makeAuthRequest(caller.userId, caller.email, {
    method: "POST",
    params: { roundId: ctx.roundId, teamId: ctx.teamId, place: "1" },
    headers: {
      "x-forwarded-for": "10.0.0.1, 203.0.113.42",
      "user-agent": "round-lifecycle-test",
    },
  }));
}

function overrideSign(ctx: LifecycleContext, reason: string) {
  return invoke("overrideSlotSignature", makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "POST",
    params: { roundId: ctx.roundId, teamId: ctx.teamId, place: "1" },
    body: { reason, onBehalfOfPilotId: ctx.pilotId },
    headers: {
      "x-forwarded-for": "10.0.0.1, 203.0.113.43",
      "user-agent": "round-lifecycle-override-test",
    },
  }));
}

function updateBrief(ctx: LifecycleContext, brief: RoundBrief) {
  return invoke("updateRoundBrief", makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "PUT",
    params: { id: ctx.roundId },
    body: brief,
  }));
}

async function waitForPublicBlob(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await publicBlobExists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function readPublicBytes(path: string): Promise<Buffer> {
  const response = await getPublicContainer().getBlobClient(path).download();
  const chunks: Buffer[] = [];
  for await (const chunk of response.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function listPrivateBlobNames(prefix: string): Promise<string[]> {
  const names: string[] = [];
  for await (const item of getPrivateContainer().listBlobsFlat({ prefix })) {
    names.push(item.name);
  }
  return names;
}

async function readAuditLines(): Promise<Array<Record<string, unknown>>> {
  const path = `audit/sign-override-${new Date().toISOString().slice(0, 10)}.jsonl`;
  const response = await getPrivateContainer().getBlobClient(path).download();
  const chunks: Buffer[] = [];
  for await (const chunk of response.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
