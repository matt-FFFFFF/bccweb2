// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Round, Team } from "@bccweb/types";
import { describe, expect, it } from "vitest";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import {
  makeSetCaptainRequest,
  seedRoundWithTeam,
} from "./teamsCaptain.testHelpers.js";
import "../teamsCaptain.js";

describe("PUT /api/rounds/{id}/teams/{teamId}/captain", () => {
  it("admin role: 200 + captainPilotId updated in blob", async () => {
    const { round, team, pilot } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: pilot.id },
      })
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as Team).captainPilotId).toBe(pilot.id);
    const stored = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(stored?.teams[0].captainPilotId).toBe(pilot.id);
  });

  it("RoundsCoord with matching club: 200 + captainPilotId updated", async () => {
    resetAllBuckets();
    const { round, team, pilot, clubId } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: pilot.id },
      })
    );
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
      makeSetCaptainRequest(user, round, team, pilot.id)
    );
    for (let index = 0; index < 30; index += 1) {
      res = await invoke(
        "setTeamCaptain",
        makeSetCaptainRequest(user, round, team, pilot.id)
      );
    }
    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("FORBIDDEN");
    expect(
      (res.headers as Record<string, string> | undefined)?.["Retry-After"]
    ).toBeUndefined();
  });

  it("RoundsCoord with wrong club: 403", async () => {
    const { round, team, pilot } = await seedRoundWithTeam();
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: randomUUID(),
    });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: pilot.id },
      })
    );
    expect(res.status).toBe(403);
  });

  it("Pilot role: 403", async () => {
    const { round, team, pilot } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: pilot.id });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: pilot.id },
      })
    );
    expect(res.status).toBe(403);
  });

  it("non-existent team: 404", async () => {
    const { round } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: randomUUID() },
        body: { pilotId: null },
      })
    );
    expect(res.status).toBe(404);
    expect((res.jsonBody as { code: string }).code).toBe("NOT_FOUND");
  });

  it("pilotId not in team: 400 PILOT_NOT_IN_TEAM", async () => {
    const { round, team } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: randomUUID() },
      })
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("PILOT_NOT_IN_TEAM");
  });

  it("pilotId: null clears captain", async () => {
    const { round, team, pilot } = await seedRoundWithTeam({
      captainPilotId: "some-prior-captain",
    });
    const stored = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    if (stored) {
      stored.teams[0].captainPilotId = pilot.id;
      await writePrivateJson(`rounds/${round.id}.json`, stored);
    }
    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: null },
      })
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as Team).captainPilotId).toBeNull();
  });
});
