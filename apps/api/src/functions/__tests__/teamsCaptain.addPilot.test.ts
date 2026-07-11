// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Round, Team } from "@bccweb/types";
import { describe, expect, it } from "vitest";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import {
  makeConfig,
  makePilot,
  makeRound,
  makeUser,
} from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import { randomForwardedFor } from "./teamsCaptain.testHelpers.js";
import "../teams.js";

describe("POST /api/rounds/{id}/teams/{teamId}/pilots — positional eligibility", () => {
  it("fills first-free places with a positional scoring band; a removed place is reused (not max+1) and the cap rejects overflow", async () => {
    resetAllBuckets();
    const clubId = randomUUID();
    await makeConfig({ maxPilotsInTeam: 9, maxScoringPilotsInTeam: 6 });
    const team: Team = {
      id: randomUUID(),
      teamName: "Alpha",
      club: { id: clubId, name: "Test Club" },
      score: 0,
      pilots: [],
    };
    const round = await makeRound({
      organisingClubId: clubId,
      organisingClubName: "Test Club",
      teams: [team],
    });
    const { user } = await makeUser({ roles: ["Admin"] });

    for (let place = 1; place <= 9; place += 1) {
      const pilot = await makePilot({ firstName: `Fill${place}`, clubId });
      const res = await addPilot(user, round, team, pilot.id);
      expect(res.status).toBe(200);
      const slot = (res.jsonBody as Round).teams[0].pilots.find(
        (candidate) => candidate.pilotId === pilot.id
      );
      expect(slot?.placeInTeam).toBe(place);
      expect(slot?.isScoring).toBe(place <= 6);
    }

    const removeRes = await invoke(
      "removePilot",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { id: round.id, teamId: team.id, place: "2" },
        headers: { "x-forwarded-for": randomForwardedFor() },
      })
    );
    expect(removeRes.status).toBe(200);

    const rejoin = await makePilot({ firstName: "Rejoin", clubId });
    const rejoinRes = await addPilot(user, round, team, rejoin.id);
    expect(rejoinRes.status).toBe(200);
    const rejoinSlot = (rejoinRes.jsonBody as Round).teams[0].pilots.find(
      (candidate) => candidate.pilotId === rejoin.id
    );
    expect(rejoinSlot?.placeInTeam).toBe(2);
    expect(rejoinSlot?.isScoring).toBe(true);

    const overflow = await makePilot({ firstName: "Overflow", clubId });
    const overflowRes = await addPilot(user, round, team, overflow.id);
    expect(overflowRes.status).toBe(409);
    expect((overflowRes.jsonBody as { code: string }).code).toBe("TEAM_FULL");
  });
});

function addPilot(
  user: { readonly id: string; readonly email: string },
  round: Round,
  team: Team,
  pilotId: string
) {
  return invoke(
    "addPilot",
    makeAuthRequest(user.id, user.email, {
      method: "POST",
      params: { id: round.id, teamId: team.id },
      headers: { "x-forwarded-for": randomForwardedFor() },
      body: { pilotId },
    })
  );
}
