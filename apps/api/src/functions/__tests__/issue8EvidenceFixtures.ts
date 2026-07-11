// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Round, Team } from "@bccweb/types";
import { expect } from "vitest";
import {
  makeClub,
  makePilot,
  makeRound,
} from "../../__tests__/helpers/seed.js";
import {
  invokeEvidenceHandler,
  makeEvidenceRequest,
  seedEvidenceUser,
} from "./issue8EvidenceHarness.js";

export async function roundForOtherClub(
  status: Round["status"] = "Proposed"
): Promise<Round> {
  return makeRound({ organisingClubId: randomUUID(), status });
}

export async function roundWithFlight(
  flightId: string,
  ownerPilotId: string
): Promise<Round> {
  const clubId = randomUUID();
  const team: Team = {
    id: randomUUID(),
    teamName: "Flight Team",
    club: { id: clubId, name: "Flight Club" },
    score: 0,
    pilots: [
      {
        placeInTeam: 1,
        pilotId: ownerPilotId,
        isScoring: true,
        status: "Filled",
        accountedFor: false,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
        flight: {
          id: flightId,
          distance: 10,
          duration: 60,
          scoringType: "XC",
          score: 0,
          wingFactor: 1,
          isManualLog: false,
        },
      },
    ],
  };
  return makeRound({
    organisingClubId: clubId,
    status: "Locked",
    teams: [team],
  });
}

export async function seedPilotSeasonClubAssignment(
  seasonYear: number,
  clubId: string
): Promise<string> {
  const club = await makeClub({
    id: clubId,
    name: `Season Club ${clubId.slice(0, 6)}`,
  });
  const admin = await seedEvidenceUser({ roles: ["Admin"] });
  const createSeasonClub = await invokeEvidenceHandler(
    "createSeasonClub",
    makeEvidenceRequest(admin, {
      method: "POST",
      params: { year: String(seasonYear) },
      body: { clubId: club.id, numTeams: 1, acceptTsCs: true },
    })
  );
  expect([201, 409]).toContain(createSeasonClub.status);
  const pilot = await makePilot();
  const assign = await invokeEvidenceHandler(
    "assignPilotSeasonClub",
    makeEvidenceRequest(admin, {
      method: "POST",
      body: { pilotId: pilot.id, clubId: club.id, seasonYear },
    })
  );
  expect(assign.status).toBe(201);
  return pilot.id;
}
