import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pilot, Round, Signature, Team } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeConfig, makePilot, makeRound, makeUser, readPrivateJson, writePrivateJson } from "../../__tests__/helpers/seed.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import { signaturePath, writeSignature } from "../../lib/signTofly/ledger.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import "../roundRegistration.js";

describe("round self-registration endpoints", () => {
  it("pilot registers self -> 200; slot filled with pilotSnapshot", async () => {
    const ctx = await seedRegistrationRound();

    const res = await register(ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ roundId: ctx.round.id, teamId: ctx.team.id, place: 1 });
    const round = await readPrivateJson<Round>(`rounds/${ctx.round.id}.json`);
    expect(round?.teams[0].pilots[0]).toMatchObject({
      placeInTeam: 1,
      status: "Filled",
      pilotId: ctx.pilot.id,
      snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
    });
  });

  it("pilot already in another round same date -> 409 DOUBLE_BOOKING with conflict detail", async () => {
    const ctx = await seedRegistrationRound();
    const conflict = await makeRound({
      date: ctx.round.date,
      seasonYear: ctx.round.season.year,
      organisingClubId: ctx.clubId,
      organisingClubName: "Test Club",
      teams: [makeTeam(ctx.clubId, "Conflict", [{ placeInTeam: 1, pilotId: ctx.pilot.id }])],
    });

    const res = await register(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string; detail: string }).code).toBe("DOUBLE_BOOKING");
    expect((res.jsonBody as { detail: string }).detail).toContain(conflict.id);
    expect((res.jsonBody as { detail: string }).detail).toContain(conflict.date);
  });

  it("pilot's profile missing required fields -> 422 PROFILE_INCOMPLETE", async () => {
    const ctx = await seedRegistrationRound({ pilotOverrides: { firstName: "" } });

    const res = await register(ctx);

    expect(res.status).toBe(422);
    expect((res.jsonBody as { code: string }).code).toBe("PROFILE_INCOMPLETE");
  });

  it("round in BriefComplete -> 409 REGISTRATION_CLOSED", async () => {
    const ctx = await seedRegistrationRound({ roundStatus: "BriefComplete" });

    const res = await register(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string; detail: string }).code).toBe("REGISTRATION_CLOSED");
    expect((res.jsonBody as { detail: string }).detail).toContain("BriefComplete");
  });

  it("team full -> 409 TEAM_FULL", async () => {
    const ctx = await seedRegistrationRound({
      team: makeTeam(randomUUID(), "Full", [
        { placeInTeam: 1, pilotId: randomUUID() },
        { placeInTeam: 2, pilotId: randomUUID() },
      ]),
      maxPilotsInTeam: 2,
    });

    const res = await register(ctx);
    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("TEAM_FULL");
  });

  it("auto-fills the next free slot regardless of any requested place -> 200, place 2", async () => {
    const ctx = await seedRegistrationRound({
      teamSlots: [{ placeInTeam: 1, pilotId: randomUUID() }],
    });

    const res = await register(ctx, { preferredPlace: 1 });
    expect(res.status).toBe(200);
    expect((res.jsonBody as { place: number }).place).toBe(2);
  });

  it("unregister before signing -> 200; slot emptied", async () => {
    const ctx = await seedRegistrationRound({
      teamSlots: [{ placeInTeam: 1, pilotId: "self" }],
    });

    const res = await unregister(ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ removedFromTeamId: ctx.team.id, removedFromPlace: 1 });
    const round = await readPrivateJson<Round>(`rounds/${ctx.round.id}.json`);
    expect(round?.teams[0].pilots[0]).toMatchObject({ status: "Empty", pilotId: null, snapshot: null });
  });

  it("unregister after signing -> 409 SIGNED_CONTACT_COORD", async () => {
    const ctx = await seedRegistrationRound({
      teamSlots: [{ placeInTeam: 1, pilotId: "self" }],
    });
    const sig = makeSignature(ctx);
    await writeSignature(sig);

    const res = await unregister(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string; detail: string }).code).toBe("SIGNED_CONTACT_COORD");
    expect(await readPrivateJson<Signature>(signaturePath(ctx.round.id, ctx.team.id, 1, 1))).toEqual(sig);
  });

  it("non-pilot role -> 403 NOT_A_PILOT", async () => {
    const ctx = await seedRegistrationRound();
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: ctx.clubId });

    const res = await invoke(
      "registerSelfForRound",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        params: { roundId: ctx.round.id },
        body: { teamId: ctx.team.id },
      }),
    );

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("NOT_A_PILOT");
  });

  it("two pilots from same IP can register back-to-back (per-pilot rate-limit bucket)", async () => {
    const ctx = await seedRegistrationRound();

    const secondPilot = await makePilot({ firstName: "Bob", lastName: "Pilot", clubId: ctx.clubId });
    secondPilot.seasonClubs = [{ seasonYear: 2026, clubId: ctx.clubId, clubName: "Test Club" }];
    await writePrivateJson(`pilots/${secondPilot.id}.json`, secondPilot);
    const { user: secondUser } = await makeUser({
      roles: ["Pilot"],
      pilotId: secondPilot.id,
      clubId: ctx.clubId,
    });

    const sharedIp = "203.0.113.42";

    const first = await invoke(
      "registerSelfForRound",
      makeAuthRequest(ctx.userId, ctx.email, {
        method: "POST",
        params: { roundId: ctx.round.id },
        body: { teamId: ctx.team.id, preferredPlace: 1 },
        headers: { "x-forwarded-for": sharedIp },
      }),
    );

    const second = await invoke(
      "registerSelfForRound",
      makeAuthRequest(secondUser.id, secondUser.email, {
        method: "POST",
        params: { roundId: ctx.round.id },
        body: { teamId: ctx.team.id, preferredPlace: 2 },
        headers: { "x-forwarded-for": sharedIp },
      }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.jsonBody as { place: number }).place).toBe(2);
  });

  it("pilot whose club is NOT the organiser can register into their own club's team -> 200", async () => {
    resetAllBuckets();
    await makeConfig({ maxPilotsInTeam: 3 });
    const pilotClubId = randomUUID();
    const hostClubId = randomUUID();
    const pilot = await makePilot({ firstName: "Cara", lastName: "Pilot", clubId: pilotClubId });
    pilot.seasonClubs = [{ seasonYear: 2026, clubId: pilotClubId, clubName: "Visitor Club" }];
    await writePrivateJson(`pilots/${pilot.id}.json`, pilot);
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: pilot.id, clubId: pilotClubId });

    const visitorTeam = makeTeam(pilotClubId, "Visitor Team");
    const round = await makeRound({
      date: "2026-06-10",
      status: "Confirmed",
      seasonYear: 2026,
      organisingClubId: hostClubId,
      organisingClubName: "Host Club",
      teams: [visitorTeam],
    });

    const res = await invoke(
      "registerSelfForRound",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        params: { roundId: round.id },
        body: { teamId: visitorTeam.id },
        headers: { "x-forwarded-for": `${randomUUID()}.test` },
      }),
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as { teamId: string; place: number }).teamId).toBe(visitorTeam.id);
    const saved = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(saved?.teams[0].pilots[0]?.pilotId).toBe(pilot.id);
  });

  it("pilot's club has no team in the round -> 409 NO_TEAM_FOR_CLUB", async () => {
    resetAllBuckets();
    await makeConfig({ maxPilotsInTeam: 3 });
    const pilotClubId = randomUUID();
    const hostClubId = randomUUID();
    const pilot = await makePilot({ firstName: "Dee", lastName: "Pilot", clubId: pilotClubId });
    pilot.seasonClubs = [{ seasonYear: 2026, clubId: pilotClubId, clubName: "Lonely Club" }];
    await writePrivateJson(`pilots/${pilot.id}.json`, pilot);
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: pilot.id, clubId: pilotClubId });

    const hostTeam = makeTeam(hostClubId, "Host Team");
    const round = await makeRound({
      date: "2026-06-11",
      status: "Confirmed",
      seasonYear: 2026,
      organisingClubId: hostClubId,
      organisingClubName: "Host Club",
      teams: [hostTeam],
    });

    const res = await invoke(
      "registerSelfForRound",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        params: { roundId: round.id },
        body: {},
        headers: { "x-forwarded-for": `${randomUUID()}.test` },
      }),
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("NO_TEAM_FOR_CLUB");
  });

  it("self-registration into a place within the scoring band -> isScoring true", async () => {
    const ctx = await seedRegistrationRound({
      maxPilotsInTeam: 9,
      teamSlots: [1, 2, 3, 4, 5].map((placeInTeam) => ({ placeInTeam, pilotId: randomUUID() })),
    });

    const res = await register(ctx);

    expect(res.status).toBe(200);
    expect((res.jsonBody as { place: number }).place).toBe(6);
    const round = await readPrivateJson<Round>(`rounds/${ctx.round.id}.json`);
    expect(round?.teams[0].pilots.find((s) => s.placeInTeam === 6)?.isScoring).toBe(true);
  });

  it("self-registration into a place beyond the scoring band -> isScoring false", async () => {
    const ctx = await seedRegistrationRound({
      maxPilotsInTeam: 9,
      teamSlots: [1, 2, 3, 4, 5, 6].map((placeInTeam) => ({ placeInTeam, pilotId: randomUUID() })),
    });

    const res = await register(ctx);

    expect(res.status).toBe(200);
    expect((res.jsonBody as { place: number }).place).toBe(7);
    const round = await readPrivateJson<Round>(`rounds/${ctx.round.id}.json`);
    expect(round?.teams[0].pilots.find((s) => s.placeInTeam === 7)?.isScoring).toBe(false);
  });

  it("missing config falls back to legacy schema defaults so place 7 is free and non-scoring", async () => {
    // Given a 3-slot config that is then DELETED, readConfig must fall back to
    // ConfigSchema.parse({}) (maxPilotsInTeam 9, maxScoringPilotsInTeam 6). Were
    // the seeded 3-slot config still in effect, place 7 would be TEAM_FULL.
    const ctx = await seedRegistrationRound({
      teamSlots: [1, 2, 3, 4, 5, 6].map((placeInTeam) => ({ placeInTeam, pilotId: randomUUID() })),
    });
    await getPrivateContainer().getBlockBlobClient("config.json").deleteIfExists();

    const res = await register(ctx);

    expect(res.status).toBe(200);
    expect((res.jsonBody as { place: number }).place).toBe(7);
    const round = await readPrivateJson<Round>(`rounds/${ctx.round.id}.json`);
    expect(round?.teams[0].pilots.find((s) => s.placeInTeam === 7)?.isScoring).toBe(false);
  });

  it("a tenth self-registration into a full 9-place team -> 409 TEAM_FULL", async () => {
    const ctx = await seedRegistrationRound({
      maxPilotsInTeam: 9,
      teamSlots: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((placeInTeam) => ({ placeInTeam, pilotId: randomUUID() })),
    });

    const res = await register(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("TEAM_FULL");
  });
});

interface SlotSeed {
  placeInTeam: number;
  pilotId: string | null;
}

interface RegistrationContext {
  clubId: string;
  pilot: Pilot;
  userId: string;
  email: string;
  round: Round;
  team: Team;
}

async function seedRegistrationRound(opts: {
  roundStatus?: Round["status"];
  pilotOverrides?: { firstName?: string; lastName?: string };
  teamSlots?: SlotSeed[];
  team?: Team;
  maxPilotsInTeam?: number;
} = {}): Promise<RegistrationContext> {
  resetAllBuckets();
  const clubId = opts.team?.club.id ?? randomUUID();
  await makeConfig({ maxPilotsInTeam: opts.maxPilotsInTeam ?? 3 });
  const pilot = await makePilot({
    firstName: opts.pilotOverrides?.firstName ?? "Ava",
    lastName: opts.pilotOverrides?.lastName ?? "Pilot",
    clubId,
  });
  pilot.seasonClubs = [{ seasonYear: 2026, clubId, clubName: "Test Club" }];
  await writePrivateJson(`pilots/${pilot.id}.json`, pilot);
  const { user } = await makeUser({ roles: ["Pilot"], pilotId: pilot.id, clubId });

  const seededSlots = opts.teamSlots?.map((slot) => ({
    placeInTeam: slot.placeInTeam,
    pilotId: slot.pilotId === "self" ? pilot.id : slot.pilotId,
  }));
  const team = opts.team ?? makeTeam(clubId, "Test Team", seededSlots);
  if (opts.team) {
    opts.team.club = { id: clubId, name: "Test Club" };
  }

  const round = await makeRound({
    date: "2026-06-09",
    status: opts.roundStatus ?? "Confirmed",
    seasonYear: 2026,
    organisingClubId: clubId,
    organisingClubName: "Test Club",
    teams: [team],
  });

  return { clubId, pilot, userId: user.id, email: user.email, round, team };
}

function makeTeam(clubId: string, name: string, slots: SlotSeed[] = []): Team {
  return {
    id: randomUUID(),
    teamName: name,
    club: { id: clubId, name: "Test Club" },
    score: 0,
    pilots: slots.map((slot) => ({
      placeInTeam: slot.placeInTeam,
      isScoring: true,
      status: slot.pilotId ? "Filled" : "Empty",
      accountedFor: false,
      signToFly: false,
      noScore: false,
      pilotPoints: 0,
      pilotId: slot.pilotId,
      snapshot: null,
      flight: null,
    })),
  };
}

async function register(ctx: RegistrationContext, body: { preferredPlace?: number } = {}) {
  return invoke(
    "registerSelfForRound",
    makeAuthRequest(ctx.userId, ctx.email, {
      method: "POST",
      params: { roundId: ctx.round.id },
      body: { teamId: ctx.team.id, ...body },
      headers: { "x-forwarded-for": `${randomUUID()}.test` },
    }),
  );
}

async function unregister(ctx: RegistrationContext) {
  return invoke(
    "unregisterSelfFromRound",
    makeAuthRequest(ctx.userId, ctx.email, {
      method: "POST",
      params: { roundId: ctx.round.id },
      headers: { "x-forwarded-for": `${randomUUID()}.test` },
    }),
  );
}

function makeSignature(ctx: RegistrationContext): Signature {
  return {
    id: randomUUID(),
    roundId: ctx.round.id,
    teamId: ctx.team.id,
    place: 1,
    pilotId: ctx.pilot.id,
    userId: ctx.userId,
    signedAt: new Date().toISOString(),
    briefVersion: 1,
    briefHash: "brief-hash",
    wordingVersion: 1,
    wordingHash: "wording-hash",
    ip: null,
    userAgent: null,
    source: "pilot-self",
  };
}
