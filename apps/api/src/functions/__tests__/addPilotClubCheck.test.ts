// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "crypto";
import type { Club, Pilot, Round, Team } from "@bccweb/types";
import { describe, expect, test } from "vitest";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import {
  makeClub,
  makeClubTeam,
  makePilot,
  makeRound,
  makeUser,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import "../teams.js";

interface AddPilotErrorBody {
  code?: string;
}

function randomForwardedFor(): string {
  return `10.71.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}

function authReq(
  user: { id: string; email: string },
  options: NonNullable<Parameters<typeof makeAuthRequest>[2]>,
) {
  return makeAuthRequest(user.id, user.email, {
    ...options,
    headers: {
      ...options.headers,
      "x-forwarded-for": randomForwardedFor(),
    },
  });
}

function teamForClub(club: Club, teamName: string): Team {
  return {
    id: randomUUID(),
    teamName,
    club: { id: club.id, name: club.name },
    score: 0,
    pilots: [],
  };
}

async function seedRoundWithTeam(options: { status?: Round["status"]; teams?: Team[] } = {}) {
  const seasonYear = 3_000 + Math.floor(Math.random() * 6_000);
  const club = await makeClub({ name: `Add Pilot Club ${randomUUID().slice(0, 8)}` });
  await makeClubTeam({ clubId: club.id, clubName: club.name, seasonYear, teamName: "Alpha" });
  const team = options.teams?.[0] ?? teamForClub(club, "Alpha");
  const round = await makeRound({ seasonYear, status: options.status, teams: options.teams ?? [team] });
  return { club, round, team };
}

async function addPilot(user: { id: string; email: string }, roundId: string, teamId: string, pilotId: string) {
  return invoke(
    "addPilot",
    authReq(user, {
      method: "POST",
      params: { id: roundId, teamId },
      body: { pilotId },
    }),
  );
}

async function readRound(roundId: string): Promise<Round> {
  const round = await readPrivateJson<Round>(`rounds/${roundId}.json`);
  if (!round) throw new Error(`Round ${roundId} was not written`);
  return round;
}

async function readPilot(pilotId: string): Promise<Pilot> {
  const pilot = await readPrivateJson<Pilot>(`pilots/${pilotId}.json`);
  if (!pilot) throw new Error(`Pilot ${pilotId} was not written`);
  return pilot;
}

describe("POST /api/rounds/{id}/teams/{teamId}/pilots club membership gate", () => {
  test("adds a current-club pilot and records that pilot's season club", async () => {
    const { club, round, team } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: club.id });
    const pilot = await makePilot({ clubId: club.id, firstName: "Current", lastName: "Club" });

    const res = await addPilot(user, round.id, team.id, pilot.id);

    expect(res.status).toBe(200);
    const updatedRound = await readRound(round.id);
    expect(updatedRound.teams[0]?.pilots.map((slot) => slot.pilotId)).toContain(pilot.id);
    const updatedPilot = await readPilot(pilot.id);
    expect(updatedPilot.seasonClubs).toContainEqual({
      seasonYear: round.season.year,
      clubId: club.id,
      clubName: club.name,
    });
  });

  test("rejects when a different season club overrides the pilot's matching current club", async () => {
    const { club, round, team } = await seedRoundWithTeam();
    const otherClub = await makeClub({ name: `Other Club ${randomUUID().slice(0, 8)}` });
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: club.id });
    const pilot = await makePilot({ clubId: club.id, firstName: "Season", lastName: "Wins" });
    await writePrivateJson(`pilots/${pilot.id}.json`, {
      ...pilot,
      seasonClubs: [{ seasonYear: round.season.year, clubId: otherClub.id, clubName: otherClub.name }],
    });
    const beforeRound = await readRound(round.id);

    const res = await addPilot(user, round.id, team.id, pilot.id);

    expect(res.status).toBe(422);
    expect((res.jsonBody as AddPilotErrorBody).code).toBe("TEAM_CLUB_MISMATCH");
    await expect(readRound(round.id)).resolves.toEqual(beforeRound);
  });

  test("rejects a pilot with no current or season club without writing seasonClubs", async () => {
    const { club, round, team } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: club.id });
    const pilot = await makePilot({ firstName: "No", lastName: "Club" });

    const res = await addPilot(user, round.id, team.id, pilot.id);

    expect(res.status).toBe(422);
    expect((res.jsonBody as AddPilotErrorBody).code).toBe("NO_CLUB_FOR_SEASON");
    expect((await readPilot(pilot.id)).seasonClubs).toEqual([]);
  });

  test("rejects an Admin adding a pilot from another club", async () => {
    const { round, team } = await seedRoundWithTeam();
    const otherClub = await makeClub({ name: `Admin Block ${randomUUID().slice(0, 8)}` });
    const { user } = await makeUser({ roles: ["Admin"] });
    const pilot = await makePilot({ clubId: otherClub.id, firstName: "Admin", lastName: "Blocked" });

    const res = await addPilot(user, round.id, team.id, pilot.id);

    expect(res.status).toBe(422);
    expect((res.jsonBody as AddPilotErrorBody).code).toBe("TEAM_CLUB_MISMATCH");
  });

  test("rejects a frozen roster before recording the pilot's season club", async () => {
    const { club, round, team } = await seedRoundWithTeam({ status: "Locked" });
    const { user } = await makeUser({ roles: ["Admin"] });
    const pilot = await makePilot({ clubId: club.id, firstName: "Frozen", lastName: "Roster" });

    const res = await addPilot(user, round.id, team.id, pilot.id);

    expect(res.status).toBe(409);
    expect((res.jsonBody as AddPilotErrorBody).code).toBe("CONFLICT");
    expect((await readPilot(pilot.id)).seasonClubs).toEqual([]);
  });

  test("rejects a pilot already filled elsewhere and leaves that slot unchanged", async () => {
    const seasonYear = 3_000 + Math.floor(Math.random() * 6_000);
    const club = await makeClub({ name: `Double Club ${randomUUID().slice(0, 8)}` });
    await makeClubTeam({ clubId: club.id, clubName: club.name, seasonYear, teamName: "Alpha" });
    await makeClubTeam({ clubId: club.id, clubName: club.name, seasonYear, teamName: "Beta" });
    const pilot = await makePilot({ clubId: club.id, firstName: "Already", lastName: "Booked" });
    const targetTeam = teamForClub(club, "Alpha");
    const existingTeam = teamForClub(club, "Beta");
    existingTeam.pilots.push({
      placeInTeam: 1,
      isScoring: true,
      status: "Filled",
      accountedFor: false,
      signToFly: false,
      noScore: false,
      pilotPoints: 0,
      pilotId: pilot.id,
      snapshot: null,
      flight: null,
    });
    const round = await makeRound({ seasonYear, teams: [targetTeam, existingTeam] });
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: club.id });
    const beforeSlot = (await readRound(round.id)).teams[1]?.pilots[0];

    const res = await addPilot(user, round.id, targetTeam.id, pilot.id);

    expect(res.status).toBe(409);
    const after = await readRound(round.id);
    expect(after.teams[1]?.pilots[0]).toEqual(beforeSlot);
    expect(after.teams[0]?.pilots).toEqual([]);
  });
});
