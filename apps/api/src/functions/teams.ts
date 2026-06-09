/**
 * Team & pilot management endpoints — Phase 3
 *
 * POST   /api/rounds/{id}/teams                                    — add team
 * DELETE /api/rounds/{id}/teams/{teamId}                          — remove team
 * POST   /api/rounds/{id}/teams/{teamId}/pilots                   — add pilot to team
 * DELETE /api/rounds/{id}/teams/{teamId}/pilots/{place}           — remove pilot slot
 * PUT    /api/rounds/{id}/teams/{teamId}/pilots/{place}/accounted  — toggle accounted-for
 * PUT    /api/rounds/{id}/teams/{teamId}/pilots/{place}/sign-to-fly — toggle sign-to-fly
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "crypto";
import type { Round, Team, PilotSlot } from "@bccweb/types";
import { getPrivateBlobClient, readBlob, writePrivateBlob, withPrivateLease } from "../lib/blob.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";

// ─── Auth helper ──────────────────────────────────────────────────────────────

function isCoord(roles: string[]): boolean {
  return roles.includes("RoundsCoord") || roles.includes("Admin");
}

// ─── Generic round mutator ────────────────────────────────────────────────────

/**
 * Acquire a lease on the round blob, load it, apply `mutateFn`, and write
 * back. Returns the updated round or an HttpResponseInit error.
 */
async function mutateLocked(
  id: string,
  mutateFn: (round: Round) => void | string
): Promise<Round | HttpResponseInit> {
  const path = `rounds/${id}.json`;

  try {
    return await withPrivateLease(path, async (leaseId) => {
      const r = await readBlob<Round>(getPrivateBlobClient(path));
      const err = mutateFn(r);
      if (err) {
        const e = new Error(err);
        (e as { isValidation?: boolean }).isValidation = true;
        throw e;
      }
      await writePrivateBlob(path, r, leaseId);
      return r;
    });
  } catch (e: unknown) {
    const err = e as { isValidation?: boolean; statusCode?: number; message?: string };
    if (err.isValidation) return { status: 409, jsonBody: { error: err.message } };
    if (err.statusCode === 404) return { status: 404, jsonBody: { error: "Round not found" } };
    throw e;
  }
}

// ─── POST /api/rounds/{id}/teams ──────────────────────────────────────────────

async function addTeam(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const id = req.params["id"];
  if (!id) return { status: 400, jsonBody: { error: "Missing round id" } };

  const body = (await req.json()) as { clubId?: string; teamName?: string };
  if (!body.clubId || !body.teamName?.trim()) {
    return { status: 400, jsonBody: { error: "clubId and teamName are required" } };
  }

  // Load club name
  let clubName: string;
  try {
    const club = await readBlob<{ id: string; name: string }>(
      getPrivateBlobClient(`clubs/${body.clubId}.json`)
    );
    clubName = club.name;
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 400, jsonBody: { error: "Club not found" } };
    }
    throw err;
  }

  const newTeam: Team = {
    id: randomUUID(),
    teamName: body.teamName.trim(),
    club: { id: body.clubId, name: clubName },
    score: 0,
    pilots: [],
  };

  const result = await mutateLocked(id, (r) => {
    if (r.isLocked) return "Round is locked";
    if (r.teams.length >= r.maxTeams) {
      return `Round is full (max ${r.maxTeams} teams)`;
    }
    if (
      r.teams.some(
        (t) => t.teamName === newTeam.teamName && t.club.id === newTeam.club.id
      )
    ) {
      return "A team with that name from that club already exists in this round";
    }
    r.teams.push(newTeam);
  });

  if (typeof (result as HttpResponseInit).status === "number") return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── DELETE /api/rounds/{id}/teams/{teamId} ───────────────────────────────────

async function removeTeam(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const { id, teamId } = req.params as { id?: string; teamId?: string };
  if (!id || !teamId) {
    return { status: 400, jsonBody: { error: "Missing round or team id" } };
  }

  const result = await mutateLocked(id, (r) => {
    if (r.isLocked) return "Round is locked";
    const idx = r.teams.findIndex((t) => t.id === teamId);
    if (idx === -1) return "Team not found";
    r.teams.splice(idx, 1);
  });

  if (typeof (result as HttpResponseInit).status === "number") return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── POST /api/rounds/{id}/teams/{teamId}/pilots ──────────────────────────────

async function addPilot(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const { id, teamId } = req.params as { id?: string; teamId?: string };
  if (!id || !teamId) {
    return { status: 400, jsonBody: { error: "Missing round or team id" } };
  }

  const body = (await req.json()) as {
    pilotId?: string;
    isScoring?: boolean;
  };
  if (!body.pilotId) {
    return { status: 400, jsonBody: { error: "pilotId is required" } };
  }

  // Verify pilot exists
  try {
    await readBlob(getPrivateBlobClient(`pilots/${body.pilotId}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 400, jsonBody: { error: "Pilot not found" } };
    }
    throw err;
  }

  const result = await mutateLocked(id, (r) => {
    if (r.isLocked) return "Round is locked";

    const team = r.teams.find((t) => t.id === teamId);
    if (!team) return "Team not found";

    // Pilot may not be registered more than once in the same round
    const alreadyRegistered = r.teams.some((t) =>
      t.pilots.some((s) => s.pilotId === body.pilotId && s.status === "Filled")
    );
    if (alreadyRegistered) {
      return "Pilot is already registered in this round";
    }

    const nextPlace =
      team.pilots.length > 0
        ? Math.max(...team.pilots.map((s) => s.placeInTeam)) + 1
        : 1;

    const slot: PilotSlot = {
      placeInTeam: nextPlace,
      isScoring: body.isScoring ?? true,
      status: "Filled",
      accountedFor: false,
      signToFly: false,
      noScore: false,
      pilotPoints: 0,
      pilotId: body.pilotId!,
      snapshot: null,
      flight: null,
    };

    team.pilots.push(slot);
  });

  if (typeof (result as HttpResponseInit).status === "number") return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── DELETE /api/rounds/{id}/teams/{teamId}/pilots/{place} ────────────────────

async function removePilot(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const { id, teamId, place } = req.params as {
    id?: string;
    teamId?: string;
    place?: string;
  };
  if (!id || !teamId || !place) {
    return { status: 400, jsonBody: { error: "Missing round, team, or place" } };
  }

  const placeNum = parseInt(place, 10);
  if (isNaN(placeNum)) {
    return { status: 400, jsonBody: { error: "place must be a number" } };
  }

  const result = await mutateLocked(id, (r) => {
    if (r.isLocked) return "Round is locked";

    const team = r.teams.find((t) => t.id === teamId);
    if (!team) return "Team not found";

    const idx = team.pilots.findIndex((s) => s.placeInTeam === placeNum);
    if (idx === -1) return "Pilot slot not found";

    team.pilots.splice(idx, 1);
  });

  if (typeof (result as HttpResponseInit).status === "number") return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── PUT /api/rounds/{id}/teams/{teamId}/pilots/{place}/accounted ─────────────

async function updateAccounted(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const { id, teamId, place } = req.params as {
    id?: string;
    teamId?: string;
    place?: string;
  };
  if (!id || !teamId || !place) {
    return { status: 400, jsonBody: { error: "Missing round, team, or place" } };
  }

  const body = (await req.json()) as { accountedFor?: boolean };
  if (typeof body.accountedFor !== "boolean") {
    return { status: 400, jsonBody: { error: "accountedFor (boolean) is required" } };
  }

  const placeNum = parseInt(place, 10);

  const result = await mutateLocked(id, (r) => {
    const team = r.teams.find((t) => t.id === teamId);
    if (!team) return "Team not found";

    const slot = team.pilots.find((s) => s.placeInTeam === placeNum);
    if (!slot) return "Pilot slot not found";

    slot.accountedFor = body.accountedFor!;
  });

  if (typeof (result as HttpResponseInit).status === "number") return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── PUT /api/rounds/{id}/teams/{teamId}/pilots/{place}/sign-to-fly ───────────

async function updateSignToFly(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const { id, teamId, place } = req.params as {
    id?: string;
    teamId?: string;
    place?: string;
  };
  if (!id || !teamId || !place) {
    return { status: 400, jsonBody: { error: "Missing round, team, or place" } };
  }

  const body = (await req.json()) as { signToFly?: boolean };
  if (typeof body.signToFly !== "boolean") {
    return { status: 400, jsonBody: { error: "signToFly (boolean) is required" } };
  }

  const placeNum = parseInt(place, 10);

  const result = await mutateLocked(id, (r) => {
    const team = r.teams.find((t) => t.id === teamId);
    if (!team) return "Team not found";

    const slot = team.pilots.find((s) => s.placeInTeam === placeNum);
    if (!slot) return "Pilot slot not found";

    slot.signToFly = body.signToFly!;
  });

  if (typeof (result as HttpResponseInit).status === "number") return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("addTeam", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams",
  handler: addTeam,
});

app.http("removeTeam", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}",
  handler: removeTeam,
});

app.http("addPilot", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots",
  handler: addPilot,
});

app.http("removePilot", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots/{place}",
  handler: removePilot,
});

app.http("updateAccounted", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots/{place}/accounted",
  handler: updateAccounted,
});

app.http("updateSignToFly", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots/{place}/sign-to-fly",
  handler: updateSignToFly,
});
