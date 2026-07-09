// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import type { Flight, Round, Team } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import {
  makeUser,
  makeRound,
  makePilot,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import "../flights.js";
import "../teams.js";

async function seedRoundWithFlight(status: Round["status"]) {
  const clubId = randomUUID();
  const pilot = await makePilot({ clubId });

  const flight: Flight = {
    id: randomUUID(),
    distance: 42,
    scoringType: "XC",
    score: 0,
    wingFactor: 1,
    isManualLog: false,
  };

  const team: Team = {
    id: randomUUID(),
    teamName: "Alpha",
    club: { id: clubId, name: "Test Club" },
    score: 0,
    captainPilotId: null,
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
        flight,
      },
    ],
  };

  const round = await makeRound({
    organisingClubId: clubId,
    organisingClubName: "Test Club",
    teams: [team],
  });

  // Force the terminal status directly — the transition handlers require a full
  // roster snapshot this fixture deliberately skips.
  const stored = await readPrivateJson<Round>(`rounds/${round.id}.json`);
  if (stored) {
    stored.status = status;
    stored.isLocked = status === "Locked" || status === "Complete";
    await writePrivateJson(`rounds/${round.id}.json`, stored);
  }

  return { round, team, pilot, flight };
}

describe("DELETE flight — lock-state (issue 3)", () => {
  beforeEach(() => resetAllBuckets());

  it("Locked round: 200, flight cleared", async () => {
    const { round, flight } = await seedRoundWithFlight("Locked");
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "deleteFlight",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { id: round.id, flightId: flight.id },
      }),
    );

    expect(res.status).toBe(200);
    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams[0].pilots[0].flight).toBeNull();
  });

  it("Complete round: 409, flight retained", async () => {
    const { round, flight } = await seedRoundWithFlight("Complete");
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "deleteFlight",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { id: round.id, flightId: flight.id },
      }),
    );

    expect(res.status).toBe(409);
    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams[0].pilots[0].flight?.id).toBe(flight.id);
  });
});

describe("PUT accounted — lock-state (issue 3)", () => {
  beforeEach(() => resetAllBuckets());

  it("Locked round: 200, accountedFor set", async () => {
    const { round, team } = await seedRoundWithFlight("Locked");
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "updateAccounted",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id, place: "1" },
        body: { accountedFor: true },
      }),
    );

    expect(res.status).toBe(200);
    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams[0].pilots[0].accountedFor).toBe(true);
  });

  it("Complete round: 409", async () => {
    const { round, team } = await seedRoundWithFlight("Complete");
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "updateAccounted",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id, place: "1" },
        body: { accountedFor: true },
      }),
    );

    expect(res.status).toBe(409);
  });
});

describe("roster mutations — frozen once brief is complete", () => {
  beforeEach(() => resetAllBuckets());

  it("removeTeam at BriefComplete (isLocked false): 409, team retained", async () => {
    const { round, team } = await seedRoundWithFlight("BriefComplete");
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "removeTeam",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { id: round.id, teamId: team.id },
      }),
    );

    expect(res.status).toBe(409);
    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams).toHaveLength(1);
  });

  it("removePilot at BriefComplete (isLocked false): 409, slot retained", async () => {
    const { round, team } = await seedRoundWithFlight("BriefComplete");
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "removePilot",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { id: round.id, teamId: team.id, place: "1" },
      }),
    );

    expect(res.status).toBe(409);
    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams[0].pilots).toHaveLength(1);
  });
});
