import { describe, expect, test } from "vitest";
import { randomUUID } from "crypto";
import type { Round } from "@bccweb/types";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeClub,
  makeClubTeam,
  makeRound,
  makeUser,
} from "../../__tests__/helpers/seed.js";
import "../teams.js";

const ctx = { log: () => undefined } as never;

async function callAddTeam(
  userId: string,
  email: string,
  roundId: string,
  clubId: string,
  teamName: string
) {
  const entry = getRegisteredHandler("addTeam");
  if (!entry) throw new Error("addTeam not registered");
  const req = makeAuthRequest(userId, email, {
    method: "POST",
    params: { id: roundId },
    body: { clubId, teamName },
  });
  return (await entry.handler(req, ctx)) as {
    status: number;
    jsonBody?: unknown;
  };
}

describe("POST /api/rounds/{id}/teams — ClubTeam validation", () => {
  test("succeeds when teamName matches a ClubTeam for (clubId, seasonYear)", async () => {
    const year = 3000 + Math.floor(Math.random() * 6_000);
    const club = await makeClub({ name: "Validation Club" });
    await makeClubTeam({
      clubId: club.id,
      clubName: club.name,
      seasonYear: year,
      teamName: "Bravo",
    });
    const round = await makeRound({ seasonYear: year });
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await callAddTeam(user.id, user.email, round.id, club.id, "Bravo");

    expect(res.status).toBe(200);
    const updated = res.jsonBody as Round;
    expect(updated.teams).toHaveLength(1);
    const added = updated.teams[0];
    expect(added.teamName).toBe("Bravo");
    expect(added.club.name).toBe("Validation Club");
  });

  test("rejects with 400 UNKNOWN_TEAM_NAME when no ClubTeam matches", async () => {
    const year = 3000 + Math.floor(Math.random() * 6_000);
    const club = await makeClub({});
    const round = await makeRound({ seasonYear: year });
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await callAddTeam(user.id, user.email, round.id, club.id, "Ghost");

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("UNKNOWN_TEAM_NAME");
  });

  test("rejects when a ClubTeam exists for a different season year", async () => {
    const roundYear = 3000 + Math.floor(Math.random() * 6_000);
    const otherYear = roundYear - 1;
    const club = await makeClub({});
    await makeClubTeam({
      clubId: club.id,
      seasonYear: otherYear,
      teamName: "OldGuard",
    });
    const round = await makeRound({ seasonYear: roundYear });
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await callAddTeam(user.id, user.email, round.id, club.id, "OldGuard");

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("UNKNOWN_TEAM_NAME");
  });

  test("rejects when ClubTeam exists for a different club", async () => {
    const year = 3000 + Math.floor(Math.random() * 6_000);
    const myClub = await makeClub({});
    const otherClub = await makeClub({});
    await makeClubTeam({
      clubId: otherClub.id,
      seasonYear: year,
      teamName: "Charlie",
    });
    const round = await makeRound({ seasonYear: year });
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await callAddTeam(user.id, user.email, round.id, myClub.id, "Charlie");

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("UNKNOWN_TEAM_NAME");
  });

  test("matches case-insensitively and stores the canonical ClubTeam spelling", async () => {
    const year = 3000 + Math.floor(Math.random() * 6_000);
    const club = await makeClub({});
    await makeClubTeam({
      clubId: club.id,
      clubName: club.name,
      seasonYear: year,
      teamName: "DeltaForce",
    });
    const round = await makeRound({ seasonYear: year });
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await callAddTeam(user.id, user.email, round.id, club.id, "  deltaforce  ");

    expect(res.status).toBe(200);
    const added = (res.jsonBody as Round).teams[0];
    expect(added.teamName).toBe("DeltaForce");
  });

  test("returns 400 when teamName field missing", async () => {
    const year = 3000 + Math.floor(Math.random() * 6_000);
    const club = await makeClub({});
    const round = await makeRound({ seasonYear: year });
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const entry = getRegisteredHandler("addTeam");
    if (!entry) throw new Error("addTeam not registered");
    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      params: { id: round.id },
      body: { clubId: club.id },
    });
    const res = (await entry.handler(req, ctx)) as { status: number };

    expect(res.status).toBe(400);
  });

  test("returns 404 when the round does not exist", async () => {
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });
    const res = await callAddTeam(
      user.id,
      user.email,
      randomUUID(),
      randomUUID(),
      "Nope"
    );
    expect(res.status).toBe(404);
  });
});
