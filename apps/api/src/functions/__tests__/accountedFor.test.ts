import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Round } from "@bccweb/types";
import { makeAuthRequest, makeRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeUser, readPrivateJson, writePrivateJson } from "../../__tests__/helpers/seed.js";
import "../teams.js";

interface AccountedContext {
  roundId: string;
  clubAId: string;
  clubBId: string;
  team1Id: string;
  team2Id: string;
  captainPilotId: string;
  memberPilotId: string;
  otherPilotId: string;
}

async function seedRound(
  status: Round["status"] = "Locked",
): Promise<AccountedContext> {
  const roundId = randomUUID();
  const clubAId = randomUUID();
  const clubBId = randomUUID();
  const team1Id = randomUUID();
  const team2Id = randomUUID();
  const captainPilotId = randomUUID();
  const memberPilotId = randomUUID();
  const otherPilotId = randomUUID();

  const round: Round = {
    id: roundId,
    date: "2026-06-09",
    status,
    isLocked: status === "Locked",
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    organisingClub: { id: clubAId, name: "Club A" },
    season: { year: 2026 },
    teams: [
      {
        id: team1Id,
        teamName: "Alpha",
        club: { id: clubAId, name: "Club A" },
        score: 0,
        captainPilotId,
        pilots: [
          slot(1, captainPilotId),
          slot(2, memberPilotId),
        ],
      },
      {
        id: team2Id,
        teamName: "Bravo",
        club: { id: clubBId, name: "Club B" },
        score: 0,
        captainPilotId: otherPilotId,
        pilots: [slot(1, otherPilotId)],
      },
    ],
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
  return {
    roundId,
    clubAId,
    clubBId,
    team1Id,
    team2Id,
    captainPilotId,
    memberPilotId,
    otherPilotId,
  };
}

function slot(placeInTeam: number, pilotId: string) {
  return {
    placeInTeam,
    isScoring: true,
    status: "Filled" as const,
    accountedFor: false,
    signToFly: false,
    noScore: false,
    pilotPoints: 0,
    pilotId,
    snapshot: null,
    flight: null,
  };
}

async function account(
  ctx: AccountedContext,
  auth: { id: string; email: string } | null,
  teamId: string,
  place: number,
  accountedFor = true,
) {
  const options = {
    method: "PUT",
    params: { id: ctx.roundId, teamId, place: String(place) },
    body: { accountedFor },
  };
  const req = auth
    ? makeAuthRequest(auth.id, auth.email, options)
    : makeRequest(options);
  return invoke("updateAccounted", req);
}

async function accountedForFlag(
  ctx: AccountedContext,
  teamId: string,
  place: number,
): Promise<boolean> {
  const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
  const team = round?.teams.find((t) => t.id === teamId);
  return team?.pilots.find((s) => s.placeInTeam === place)?.accountedFor ?? false;
}

describe("updateAccounted — who can mark a pilot accounted for", () => {
  it("Admin can account for ANY slot -> 200", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await account(ctx, user, ctx.team2Id, 1);

    expect(res.status).toBe(200);
    expect(await accountedForFlag(ctx, ctx.team2Id, 1)).toBe(true);
  });

  it("organising-club coord can account for ANY slot (incl. other club's team) -> 200", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: ctx.clubAId });

    const res = await account(ctx, user, ctx.team2Id, 1);

    expect(res.status).toBe(200);
    expect(await accountedForFlag(ctx, ctx.team2Id, 1)).toBe(true);
  });

  it("coord of a DIFFERENT club -> 403", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: ctx.clubBId });

    const res = await account(ctx, user, ctx.team1Id, 2);

    expect(res.status).toBe(403);
    expect(await accountedForFlag(ctx, ctx.team1Id, 2)).toBe(false);
  });

  it("team captain can account for ANY member of THEIR team -> 200", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: ctx.captainPilotId });

    const res = await account(ctx, user, ctx.team1Id, 2);

    expect(res.status).toBe(200);
    expect(await accountedForFlag(ctx, ctx.team1Id, 2)).toBe(true);
  });

  it("team captain CANNOT account for another team's member -> 403", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: ctx.captainPilotId });

    const res = await account(ctx, user, ctx.team2Id, 1);

    expect(res.status).toBe(403);
    expect(await accountedForFlag(ctx, ctx.team2Id, 1)).toBe(false);
  });

  it("pilot can account for their OWN slot -> 200", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: ctx.memberPilotId });

    const res = await account(ctx, user, ctx.team1Id, 2);

    expect(res.status).toBe(200);
    expect(await accountedForFlag(ctx, ctx.team1Id, 2)).toBe(true);
  });

  it("non-captain pilot CANNOT account for a team-mate's slot -> 403", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: ctx.memberPilotId });

    const res = await account(ctx, user, ctx.team1Id, 1);

    expect(res.status).toBe(403);
    expect(await accountedForFlag(ctx, ctx.team1Id, 1)).toBe(false);
  });

  it("unrelated pilot -> 403", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: ctx.otherPilotId });

    const res = await account(ctx, user, ctx.team1Id, 2);

    expect(res.status).toBe(403);
  });

  it("unauthenticated -> 401", async () => {
    const ctx = await seedRound();

    const res = await account(ctx, null, ctx.team1Id, 2);

    expect(res.status).toBe(401);
  });

  it("missing accountedFor boolean -> 400", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "updateAccounted",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: ctx.roundId, teamId: ctx.team1Id, place: "2" },
        body: {},
      }),
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("INVALID_BODY");
  });

  it("partially-numeric place -> 400 INVALID_PLACE (not routed to slot 2)", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "updateAccounted",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: ctx.roundId, teamId: ctx.team1Id, place: "2abc" },
        body: { accountedFor: true },
      }),
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("INVALID_PLACE");
  });

  it("round not Locked -> 409 (accounted-for is Locked-only)", async () => {
    const ctx = await seedRound("Confirmed");
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await account(ctx, user, ctx.team1Id, 2);

    expect(res.status).toBe(409);
    expect(await accountedForFlag(ctx, ctx.team1Id, 2)).toBe(false);
  });

  it("can also CLEAR accounted-for (false) -> 200", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Admin"] });

    await account(ctx, user, ctx.team1Id, 2, true);
    const res = await account(ctx, user, ctx.team1Id, 2, false);

    expect(res.status).toBe(200);
    expect(await accountedForFlag(ctx, ctx.team1Id, 2)).toBe(false);
  });
});
