// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { BlobLeaseClient } from "@azure/storage-blob";
import type { Round, Team } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import {
  makeUser,
  makeRound,
  makePilot,
  makeConfig,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import "../teamsCaptain.js";
import "../teams.js";

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

function leaseError(statusCode: number): Error & { readonly statusCode: number } {
  return Object.assign(new Error(`lease conflict (${statusCode})`), { statusCode });
}

function failRoundLeaseOnce(roundPath: string, statusCode: number) {
  const originalAcquireLease = BlobLeaseClient.prototype.acquireLease;
  const acquireLease = vi.spyOn(BlobLeaseClient.prototype, "acquireLease");
  let pendingFailure = true;
  let roundAttempts = 0;
  acquireLease.mockImplementation(function (this: BlobLeaseClient, duration, options) {
    if (pendingFailure && this.url.includes(roundPath)) {
      roundAttempts += 1;
      pendingFailure = false;
      return Promise.reject(leaseError(statusCode));
    }
    if (this.url.includes(roundPath)) roundAttempts += 1;
    return originalAcquireLease.call(this, duration, options);
  });
  return { roundAttempts: () => roundAttempts };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PUT /api/rounds/{id}/teams/{teamId}/captain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it.each([409, 412])("raw lease acquisition %i is retried server-side", async (statusCode) => {
    const { round, team, pilot } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["Admin"] });
    const roundPath = `rounds/${round.id}.json`;
    const leaseFailure = failRoundLeaseOnce(roundPath, statusCode);

    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id: round.id, teamId: team.id },
      body: { pilotId: pilot.id },
    });

    const res = await invoke("setTeamCaptain", req);

    expect(res.status).toBe(200);
    expect(leaseFailure.roundAttempts()).toBe(2);
    const saved = await readPrivateJson<Round>(roundPath);
    expect(saved?.teams[0].captainPilotId).toBe(pilot.id);
  });

  it("TOCTOU inside lease: team club changes between pre-read and lease read -> 403", async () => {
    resetAllBuckets();
    const { round, team, pilot, clubId } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId });
    const roundPath = `rounds/${round.id}.json`;

    // Mock acquireLease to mutate the blob just before the lease is acquired,
    // simulating a race where another process reassigned the team to a different club
    const originalAcquireLease = BlobLeaseClient.prototype.acquireLease;
    const acquireLease = vi.spyOn(BlobLeaseClient.prototype, "acquireLease");
    let mutated = false;
    acquireLease.mockImplementation(async function (this: BlobLeaseClient, duration, options) {
      if (!mutated && this.url.includes(roundPath)) {
        mutated = true;
        const stored = await readPrivateJson<Round>(roundPath);
        if (stored) {
          stored.teams[0].club.id = randomUUID(); // Reassign to different club!
          await writePrivateJson(roundPath, stored);
        }
      }
      return originalAcquireLease.call(this, duration, options);
    });

    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id: round.id, teamId: team.id },
      body: { pilotId: pilot.id },
    });

    const res = await invoke("setTeamCaptain", req);

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("FORBIDDEN");

    const after = await readPrivateJson<Round>(roundPath);
    expect(after?.teams[0].captainPilotId ?? null).toBeNull();
  });
});

// ─── addPilot — first-free-place positional slot eligibility (W4.1) ─────────────

describe("POST /api/rounds/{id}/teams/{teamId}/pilots — positional eligibility", () => {
  async function seedEmptyTeamRound(clubId: string): Promise<{ round: Round; team: Team }> {
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
    return { round, team };
  }

  function addPilotReq(
    user: { id: string; email: string },
    round: Round,
    team: Team,
    pilotId: string,
  ) {
    return invoke(
      "addPilot",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        params: { id: round.id, teamId: team.id },
        headers: { "x-forwarded-for": randomForwardedFor() },
        body: { pilotId },
      }),
    );
  }

  function slotFor(res: { jsonBody?: unknown }, pilotId: string) {
    return (res.jsonBody as Round).teams[0].pilots.find((s) => s.pilotId === pilotId);
  }

  it("fills first-free places with a positional scoring band; a removed place is reused (not max+1) and the cap rejects overflow", async () => {
    resetAllBuckets();
    const clubId = randomUUID();
    await makeConfig({ maxPilotsInTeam: 9, maxScoringPilotsInTeam: 6 });
    const { round, team } = await seedEmptyTeamRound(clubId);
    const { user } = await makeUser({ roles: ["Admin"] });

    for (let place = 1; place <= 9; place += 1) {
      const pilot = await makePilot({ firstName: `Fill${place}`, clubId });
      const res = await addPilotReq(user, round, team, pilot.id);
      expect(res.status).toBe(200);
      const slot = slotFor(res, pilot.id);
      expect(slot?.placeInTeam).toBe(place);
      expect(slot?.isScoring).toBe(place <= 6);
    }

    const removeRes = await invoke(
      "removePilot",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { id: round.id, teamId: team.id, place: "2" },
        headers: { "x-forwarded-for": randomForwardedFor() },
      }),
    );
    expect(removeRes.status).toBe(200);

    const rejoin = await makePilot({ firstName: "Rejoin", clubId });
    const rejoinRes = await addPilotReq(user, round, team, rejoin.id);
    expect(rejoinRes.status).toBe(200);
    const rejoinSlot = slotFor(rejoinRes, rejoin.id);
    expect(rejoinSlot?.placeInTeam).toBe(2);
    expect(rejoinSlot?.isScoring).toBe(true);

    const overflow = await makePilot({ firstName: "Overflow", clubId });
    const overflowRes = await addPilotReq(user, round, team, overflow.id);
    expect(overflowRes.status).toBe(409);
    expect((overflowRes.jsonBody as { code: string }).code).toBe("TEAM_FULL");
  });
});
