import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ClubTeam, SeasonClub, Team } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeClub, makeConfig, makeRound, makeUser, readPrivateJson } from "../../__tests__/helpers/seed.js";
import "../seasonClubs.js";

describe("season club admin endpoints", () => {
  it("admin registers club 2026 numTeams=2 -> 2 ClubTeam blobs created with names <Club> A and B", async () => {
    await makeConfig({ maxTeamsInClub: 3 });
    const club = await makeClub({ name: "Sky Surf Club" });
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke("createSeasonClub", makeAuthRequest(user.id, user.email, {
      method: "POST",
      params: { year: "2026" },
      body: { clubId: club.id, numTeams: 2, acceptTsCs: true, acceptedBy: "Admin User" },
    }));

    expect(res.status).toBe(201);
    const body = res.jsonBody as { seasonClub: SeasonClub; teams: ClubTeam[] };
    expect(body.seasonClub).toMatchObject({ seasonYear: 2026, clubId: club.id, numTeams: 2, acceptedTsCs: true });
    expect(body.teams.map((team) => team.teamName)).toEqual(["Sky Surf Club A", "Sky Surf Club B"]);
    expect(await readPrivateJson<ClubTeam>(`club-teams/2026/${club.id}/team-1.json`)).toMatchObject({ teamName: "Sky Surf Club A" });
    expect(await readPrivateJson<ClubTeam>(`club-teams/2026/${club.id}/team-2.json`)).toMatchObject({ teamName: "Sky Surf Club B" });
  });

  it("duplicate (year, club) -> 409 ALREADY_REGISTERED", async () => {
    await makeConfig({ maxTeamsInClub: 3 });
    const club = await makeClub({ name: "Duplicate Club" });
    const { user } = await makeUser({ roles: ["Admin"] });
    const req = () => makeAuthRequest(user.id, user.email, {
      method: "POST",
      params: { year: "2027" },
      body: { clubId: club.id, numTeams: 1, acceptTsCs: true },
    });

    expect((await invoke("createSeasonClub", req())).status).toBe(201);
    const duplicate = await invoke("createSeasonClub", req());

    expect(duplicate.status).toBe(409);
    expect((duplicate.jsonBody as { code: string }).code).toBe("ALREADY_REGISTERED");
  });

  it("non-admin POST -> 403", async () => {
    await makeConfig({ maxTeamsInClub: 3 });
    const club = await makeClub({ name: "Coord Club" });
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: club.id });

    const res = await invoke("createSeasonClub", makeAuthRequest(user.id, user.email, {
      method: "POST",
      params: { year: "2028" },
      body: { clubId: club.id, numTeams: 1, acceptTsCs: true },
    }));

    expect(res.status).toBe(403);
  });

  it("delete when teams have round assignments -> 409 IN_USE_BY_ROUND", async () => {
    await makeConfig({ maxTeamsInClub: 3 });
    const club = await makeClub({ name: "Round Club" });
    const { user } = await makeUser({ roles: ["Admin"] });
    const created = await invoke("createSeasonClub", makeAuthRequest(user.id, user.email, {
      method: "POST",
      params: { year: "2029" },
      body: { clubId: club.id, numTeams: 1, acceptTsCs: true },
    }));
    const { seasonClub } = created.jsonBody as { seasonClub: SeasonClub };
    await makeRound({ seasonYear: 2029, teams: [makeAssignedTeam(club.id, club.name)] });

    const res = await invoke("deleteSeasonClub", makeAuthRequest(user.id, user.email, {
      method: "DELETE",
      params: { year: "2029", seasonClubId: seasonClub.id },
    }));

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("IN_USE_BY_ROUND");
  });
});

function makeAssignedTeam(clubId: string, clubName: string): Team {
  return {
    id: randomUUID(),
    teamName: `${clubName} A`,
    club: { id: clubId, name: clubName },
    score: 0,
    pilots: [],
  };
}
