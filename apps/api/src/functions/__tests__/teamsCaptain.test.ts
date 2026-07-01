import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import type { Round, Team } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import {
  makeUser,
  makeRound,
  makePilot,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import "../teamsCaptain.js";

// ─── Seed helper ──────────────────────────────────────────────────────────────

async function seedRoundWithTeam(overrides: {
  clubId?: string;
  captainPilotId?: string | null;
} = {}) {
  const clubId = overrides.clubId ?? randomUUID();
  const pilot = await makePilot({ clubId });

  const teamId = randomUUID();
  const team: Team = {
    id: teamId,
    teamName: "Alpha",
    club: { id: clubId, name: "Test Club" },
    score: 0,
    captainPilotId: overrides.captainPilotId ?? null,
    pilots: [
      {
        placeInTeam: 1,
        pilotId: pilot.id,
        isScoring: true,
        status: "Filled",
        accountedFor: false,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        snapshot: null,
        flight: null,
      },
    ],
  };

  const round = await makeRound({
    organisingClubId: clubId,
    organisingClubName: "Test Club",
    teams: [team],
  });

  return { round, team, pilot, clubId };
}

function randomForwardedFor(): string {
  return `10.42.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}

function makeSetCaptainRequest(
  user: { id: string; email: string },
  round: Round,
  team: Team,
  pilotId: string | null,
) {
  return makeAuthRequest(user.id, user.email, {
    method: "PUT",
    params: { id: round.id, teamId: team.id },
    headers: { "x-forwarded-for": randomForwardedFor() },
    body: { pilotId },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PUT /api/rounds/{id}/teams/{teamId}/captain", () => {
  it("admin role: 200 + captainPilotId updated in blob", async () => {
    const { round, team, pilot } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["Admin"] });

    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id: round.id, teamId: team.id },
      body: { pilotId: pilot.id },
    });

    const res = await invoke("setTeamCaptain", req);

    expect(res.status).toBe(200);
    expect((res.jsonBody as Team).captainPilotId).toBe(pilot.id);

    const stored = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(stored?.teams[0].captainPilotId).toBe(pilot.id);
  });

  it("RoundsCoord with matching club: 200 + captainPilotId updated", async () => {
    resetAllBuckets();
    const { round, team, pilot, clubId } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId });

    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id: round.id, teamId: team.id },
      body: { pilotId: pilot.id },
    });

    const res = await invoke("setTeamCaptain", req);

    expect(res.status).toBe(200);
    expect((res.jsonBody as Team).captainPilotId).toBe(pilot.id);

    const stored = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(stored?.teams[0].captainPilotId).toBe(pilot.id);
  });

  it("RoundsCoord with wrong club: exhausted bucket still returns 403 without Retry-After", async () => {
    resetAllBuckets();
    const { round, team, pilot } = await seedRoundWithTeam();
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: randomUUID(),
    });

    let res = await invoke(
      "setTeamCaptain",
      makeSetCaptainRequest(user, round, team, pilot.id),
    );
    for (let i = 0; i < 30; i += 1) {
      res = await invoke(
        "setTeamCaptain",
        makeSetCaptainRequest(user, round, team, pilot.id),
      );
    }

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("FORBIDDEN");
    expect((res.headers as Record<string, string> | undefined)?.["Retry-After"]).toBeUndefined();
  });

  it("RoundsCoord with wrong club: 403", async () => {
    const { round, team, pilot } = await seedRoundWithTeam();
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: randomUUID(), // different club
    });

    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id: round.id, teamId: team.id },
      body: { pilotId: pilot.id },
    });

    const res = await invoke("setTeamCaptain", req);

    expect(res.status).toBe(403);
  });

  it("Pilot role: 403", async () => {
    const { round, team, pilot } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: pilot.id });

    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id: round.id, teamId: team.id },
      body: { pilotId: pilot.id },
    });

    const res = await invoke("setTeamCaptain", req);

    expect(res.status).toBe(403);
  });

  it("non-existent team: 404", async () => {
    const { round } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["Admin"] });

    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id: round.id, teamId: randomUUID() },
      body: { pilotId: null },
    });

    const res = await invoke("setTeamCaptain", req);

    expect(res.status).toBe(404);
    expect((res.jsonBody as { code: string }).code).toBe("NOT_FOUND");
  });

  it("pilotId not in team: 400 PILOT_NOT_IN_TEAM", async () => {
    const { round, team } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["Admin"] });
    const outsidePilotId = randomUUID();

    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id: round.id, teamId: team.id },
      body: { pilotId: outsidePilotId },
    });

    const res = await invoke("setTeamCaptain", req);

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("PILOT_NOT_IN_TEAM");
  });

  it("pilotId: null clears captain", async () => {
    const { round, team, pilot } = await seedRoundWithTeam({
      captainPilotId: "some-prior-captain",
    });
    // Rewrite round blob so captainPilotId has a prior value
    const stored = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    if (stored) {
      stored.teams[0].captainPilotId = pilot.id;
      await writePrivateJson(`rounds/${round.id}.json`, stored);
    }

    const { user } = await makeUser({ roles: ["Admin"] });

    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id: round.id, teamId: team.id },
      body: { pilotId: null },
    });

    const res = await invoke("setTeamCaptain", req);

    expect(res.status).toBe(200);
    expect((res.jsonBody as Team).captainPilotId).toBeNull();
  });

  it("Locked round: 409 ROUND_LOCKED, captain unchanged", async () => {
    resetAllBuckets();
    const { round, team, pilot } = await seedRoundWithTeam();
    const stored = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    if (stored) {
      stored.status = "Locked";
      stored.isLocked = true;
      await writePrivateJson(`rounds/${round.id}.json`, stored);
    }

    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: pilot.id },
      }),
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("ROUND_LOCKED");

    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams[0].captainPilotId ?? null).toBeNull();
  });

  it("Complete round: 409 ROUND_LOCKED", async () => {
    resetAllBuckets();
    const { round, team, pilot } = await seedRoundWithTeam();
    const stored = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    if (stored) {
      stored.status = "Complete";
      stored.isLocked = true;
      await writePrivateJson(`rounds/${round.id}.json`, stored);
    }

    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: pilot.id },
      }),
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("ROUND_LOCKED");
  });

  it("BriefComplete round (isLocked false): 409 ROUND_LOCKED, captain unchanged", async () => {
    resetAllBuckets();
    const { round, team, pilot } = await seedRoundWithTeam();
    const stored = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    if (stored) {
      stored.status = "BriefComplete";
      stored.isLocked = false;
      await writePrivateJson(`rounds/${round.id}.json`, stored);
    }

    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: pilot.id },
      }),
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("ROUND_LOCKED");

    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams[0].captainPilotId ?? null).toBeNull();
  });
});
