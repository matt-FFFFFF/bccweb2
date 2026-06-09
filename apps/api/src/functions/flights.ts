/**
 * Flight management endpoints — Phase 3
 *
 * POST   /api/rounds/{id}/flights             — log a flight (Pilot/RoundsCoord)
 * PUT    /api/rounds/{id}/flights/{flightId}  — update a flight (Pilot(own)/RoundsCoord)
 * DELETE /api/rounds/{id}/flights/{flightId}  — delete a flight (Admin/RoundsCoord)
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "crypto";
import type { Round, Flight, ScoringType, PilotSlot } from "@bccweb/types";
import { getPrivateBlobClient, readBlob, writePrivateBlob, withPrivateLease } from "../lib/blob.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function isCoord(roles: string[]): boolean {
  return roles.includes("RoundsCoord") || roles.includes("Admin");
}

function isAdmin(roles: string[]): boolean {
  return roles.includes("Admin");
}

// ─── Mutate helper ────────────────────────────────────────────────────────────

async function mutateLocked(
  roundId: string,
  fn: (round: Round) => string | void
): Promise<Round | HttpResponseInit> {
  const path = `rounds/${roundId}.json`;
  try {
    return await withPrivateLease(path, async (leaseId) => {
      const r = await readBlob<Round>(getPrivateBlobClient(path));
      const err = fn(r);
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

// ─── Find slot by pilotId ──────────────────────────────────────────────────────

function findSlotByPilot(
  round: Round,
  pilotId: string
): PilotSlot | undefined {
  for (const team of round.teams) {
    const slot = team.pilots.find(
      (s) => s.pilotId === pilotId && s.status === "Filled"
    );
    if (slot) return slot;
  }
  return undefined;
}

// ─── Find slot by flightId ────────────────────────────────────────────────────

function findSlotByFlight(
  round: Round,
  flightId: string
): PilotSlot | undefined {
  for (const team of round.teams) {
    const slot = team.pilots.find((s) => s.flight?.id === flightId);
    if (slot) return slot;
  }
  return undefined;
}

// ─── POST /api/rounds/{id}/flights ────────────────────────────────────────────

async function logFlight(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const roundId = req.params["id"];
  if (!roundId) return { status: 400, jsonBody: { error: "Missing round id" } };

  const body = (await req.json()) as {
    pilotId?: string;
    distance?: number;
    duration?: number;
    url?: string;
    dateTime?: string;
    scoringType?: string;
    isManualLog?: boolean;
    manualLogJustification?: string;
    isFirstXC?: boolean;
    isFirstUKXC?: boolean;
    isUKPersonalBest?: boolean;
    isOverallPB?: boolean;
    awardedFirstXC?: boolean;
    awardedFirstUKXC?: boolean;
    awardedUKPB?: boolean;
    awardedOverallPB?: boolean;
  };

  if (!body.pilotId) {
    return { status: 400, jsonBody: { error: "pilotId is required" } };
  }
  if (body.distance == null || body.distance < 0) {
    return { status: 400, jsonBody: { error: "distance (km, >= 0) is required" } };
  }

  // Auth: Pilot can only log for themselves; Coord/Admin can log for anyone
  const isPilotSelf =
    caller.roles.includes("Pilot") && caller.pilotId === body.pilotId;
  if (!isCoord(caller.roles) && !isPilotSelf) {
    return forbiddenResponse("You can only log flights for yourself");
  }

  const flight: Flight = {
    id: randomUUID(),
    distance: body.distance,
    duration: body.duration,
    url: body.url,
    dateTime: body.dateTime,
    scoringType: (body.scoringType as ScoringType) ?? "XC",
    score: 0,       // computed at round completion
    wingFactor: 1,  // computed at round completion
    isManualLog: body.isManualLog ?? false,
    manualLogJustification: body.manualLogJustification,
    isFirstXC: body.isFirstXC,
    isFirstUKXC: body.isFirstUKXC,
    isUKPersonalBest: body.isUKPersonalBest,
    isOverallPB: body.isOverallPB,
    awardedFirstXC: body.awardedFirstXC,
    awardedFirstUKXC: body.awardedFirstUKXC,
    awardedUKPB: body.awardedUKPB,
    awardedOverallPB: body.awardedOverallPB,
  };

  const result = await mutateLocked(roundId, (r) => {
    if (r.status !== "Locked") {
      return `Flights can only be logged when the round is Locked (currently ${r.status})`;
    }

    const slot = findSlotByPilot(r, body.pilotId!);
    if (!slot) return "Pilot is not registered in this round";
    if (slot.flight) return "Pilot already has a flight logged — update or delete it first";

    slot.flight = flight;
  });

  if ("status" in result) return result as HttpResponseInit;
  return { status: 201, jsonBody: result };
}

// ─── PUT /api/rounds/{id}/flights/{flightId} ──────────────────────────────────

async function updateFlight(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const { id: roundId, flightId } = req.params as {
    id?: string;
    flightId?: string;
  };
  if (!roundId || !flightId) {
    return { status: 400, jsonBody: { error: "Missing round or flight id" } };
  }

  const body = (await req.json()) as Partial<Omit<Flight, "id" | "score" | "wingFactor">>;

  // Pre-read to find the slot and check auth
  let ownerPilotId: string | null = null;
  try {
    const r = await readBlob<Round>(getPrivateBlobClient(`rounds/${roundId}.json`));
    const slot = findSlotByFlight(r, flightId);
    if (!slot) return { status: 404, jsonBody: { error: "Flight not found" } };
    ownerPilotId = slot.pilotId;
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 404, jsonBody: { error: "Round not found" } };
    }
    throw err;
  }

  // Auth: Pilot can only update their own flight; Coord/Admin can update any
  const isPilotSelf =
    caller.roles.includes("Pilot") && caller.pilotId === ownerPilotId;
  if (!isCoord(caller.roles) && !isPilotSelf) {
    return forbiddenResponse("You can only update your own flights");
  }

  const result = await mutateLocked(roundId, (r) => {
    if (r.status !== "Locked") {
      return `Flights can only be updated when the round is Locked (currently ${r.status})`;
    }

    const slot = findSlotByFlight(r, flightId);
    if (!slot || !slot.flight) return "Flight not found";

    // Merge provided fields; preserve id, score, wingFactor
    if (body.distance !== undefined) slot.flight.distance = body.distance;
    if (body.duration !== undefined) slot.flight.duration = body.duration;
    if (body.url !== undefined) slot.flight.url = body.url;
    if (body.dateTime !== undefined) slot.flight.dateTime = body.dateTime;
    if (body.scoringType !== undefined) slot.flight.scoringType = body.scoringType;
    if (body.isManualLog !== undefined) slot.flight.isManualLog = body.isManualLog;
    if (body.manualLogJustification !== undefined) {
      slot.flight.manualLogJustification = body.manualLogJustification;
    }
    if (body.isFirstXC !== undefined) slot.flight.isFirstXC = body.isFirstXC;
    if (body.isFirstUKXC !== undefined) slot.flight.isFirstUKXC = body.isFirstUKXC;
    if (body.isUKPersonalBest !== undefined) slot.flight.isUKPersonalBest = body.isUKPersonalBest;
    if (body.isOverallPB !== undefined) slot.flight.isOverallPB = body.isOverallPB;
    if (body.awardedFirstXC !== undefined) slot.flight.awardedFirstXC = body.awardedFirstXC;
    if (body.awardedFirstUKXC !== undefined) slot.flight.awardedFirstUKXC = body.awardedFirstUKXC;
    if (body.awardedUKPB !== undefined) slot.flight.awardedUKPB = body.awardedUKPB;
    if (body.awardedOverallPB !== undefined) slot.flight.awardedOverallPB = body.awardedOverallPB;
  });

  if ("status" in result) return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── DELETE /api/rounds/{id}/flights/{flightId} ───────────────────────────────

async function deleteFlight(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  // Only Admin or RoundsCoord can delete flights
  if (!isCoord(caller.roles) && !isAdmin(caller.roles)) {
    return forbiddenResponse();
  }

  const { id: roundId, flightId } = req.params as {
    id?: string;
    flightId?: string;
  };
  if (!roundId || !flightId) {
    return { status: 400, jsonBody: { error: "Missing round or flight id" } };
  }

  const result = await mutateLocked(roundId, (r) => {
    // Allow delete from Locked or Complete (admin correction)
    if (r.status !== "Locked" && r.status !== "Complete") {
      return `Can only delete flights from Locked or Complete rounds (currently ${r.status})`;
    }

    const slot = findSlotByFlight(r, flightId);
    if (!slot) return "Flight not found";

    slot.flight = null;
    slot.pilotPoints = 0;
  });

  if ("status" in result) return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("logFlight", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/flights",
  handler: logFlight,
});

app.http("updateFlight", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "rounds/{id}/flights/{flightId}",
  handler: updateFlight,
});

app.http("deleteFlight", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "rounds/{id}/flights/{flightId}",
  handler: deleteFlight,
});
