// SPDX-License-Identifier: MPL-2.0
/**
 * Manual flight endpoint — record an operator-entered flight distance on a round
 * slot, superseding any IGC-derived flight already on that slot.
 *
 * POST /api/rounds/{id}/teams/{teamId}/pilots/{place}/manual-flight
 *   Admin (any round) or RoundsCoord (own organising club only). Pilot → 403.
 *
 * The round must be Locked. A manual entry is always `scoringType:"Manual"` +
 * `isManualLog:true` with a mandatory justification. When it overwrites a slot
 * that previously held an IGC flight, the stored `igcPath` is cleared AND the
 * backing `.igc` blob is deleted so the superseded track can never be re-scored.
 *
 * NOTE: `FlightSchema` (packages/schemas/src/round.ts) now carries the IGC fields
 * (`igcPath`, `sanityFlags`, `scoredAt`, `scoredByVersion`), so `readJson(RoundSchema)`
 * PRESERVES `igcPath` on read. We nonetheless read the round blob raw (`readBlob`)
 * inside the lease as a deliberate defensive choice for this lease-guarded
 * read-modify-write — belt-and-suspenders that avoids any schema-healing side
 * effects mid-transaction — then write it back via `writePrivateJson`.
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "node:crypto";
import type { Flight, PilotSlot, Round } from "@bccweb/types";
import { RoundSchema } from "@bccweb/schemas";
import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  readBlob,
  withPrivateLeaseRenewing,
} from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";

const MAX_DISTANCE_KM = 10000;

interface ManualFlightBody {
  distance?: unknown;
  manualLogJustification?: unknown;
  url?: unknown;
  duration?: unknown;
  dateTime?: unknown;
}

/** Locate the slot at `place` within team `teamId`, or null if either is absent. */
function findSlot(round: Round, teamId: string, place: number): PilotSlot | null {
  const team = round.teams.find((candidate) => candidate.id === teamId);
  return team?.pilots.find((slot) => slot.placeInTeam === place) ?? null;
}

async function recordManualFlight(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const { id: roundId, teamId } = req.params as { id?: string; teamId?: string };
  const place = parseInt(req.params["place"] ?? "", 10);
  if (!roundId || !teamId || Number.isNaN(place)) {
    throw new HttpError(400, "MISSING_IDS", "Missing round, team, or place");
  }

  const path = `rounds/${roundId}.json`;
  let round: Round;
  try {
    round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw err;
  }

  const slot = findSlot(round, teamId, place);
  if (!slot) throw new HttpError(404, "NOT_FOUND", "Pilot slot not found");

  // Role gate: Admin any round; RoundsCoord only for their own organising club.
  const isAdmin = caller.roles.includes("Admin");
  const isScopedCoord =
    caller.roles.includes("RoundsCoord") &&
    caller.clubId != null &&
    round.organisingClub?.id === caller.clubId;
  if (!isAdmin && !isScopedCoord) {
    throw new HttpError(403, "FORBIDDEN");
  }

  // Status gate: manual flights are only recorded once the roster is Locked.
  if (round.status !== "Locked") {
    throw new HttpError(
      409,
      "ROUND_NOT_LOCKED",
      `Manual flights can only be recorded when the round is Locked (currently ${round.status})`,
    );
  }

  // Body validation. Bad distance → 400; missing/empty justification → 422.
  const body = (await req.json()) as ManualFlightBody;
  const { distance } = body;
  if (
    typeof distance !== "number" ||
    !Number.isFinite(distance) ||
    distance <= 0 ||
    distance > MAX_DISTANCE_KM
  ) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      `distance must be a number greater than 0 and at most ${MAX_DISTANCE_KM} km`,
    );
  }

  const justification =
    typeof body.manualLogJustification === "string"
      ? body.manualLogJustification.trim()
      : "";
  if (justification.length === 0) {
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "manualLogJustification is required",
    );
  }

  if (body.url !== undefined && typeof body.url !== "string") {
    throw new HttpError(400, "BAD_REQUEST", "url must be a string");
  }
  if (body.duration !== undefined && typeof body.duration !== "number") {
    throw new HttpError(400, "BAD_REQUEST", "duration must be a number");
  }
  if (body.dateTime !== undefined && typeof body.dateTime !== "string") {
    throw new HttpError(400, "BAD_REQUEST", "dateTime must be a string");
  }
  const url = body.url;
  const duration = body.duration;
  const dateTime = body.dateTime;

  let oldIgcPath: string | undefined;
  let savedFlight: Flight | undefined;

  await withPrivateLeaseRenewing(path, async (leaseId) => {
    // Raw read (NOT readJson): `FlightSchema` now includes `igcPath`, so a schema
    // read would preserve it — the raw read is retained as a deliberate defensive
    // choice for this lease-guarded read-modify-write (belt-and-suspenders, avoids
    // any schema-healing side effects mid-transaction).
    const current = (await readBlob(getPrivateBlobClient(path))) as Round;
    const target = findSlot(current, teamId, place);
    if (!target) throw new HttpError(404, "NOT_FOUND", "Pilot slot not found");

    oldIgcPath = target.flight?.igcPath;

    const flight: Flight = {
      id: randomUUID(),
      distance,
      duration,
      url,
      dateTime,
      scoringType: "Manual",
      score: 0,
      wingFactor: 0,
      isManualLog: true,
      manualLogJustification: justification,
      igcPath: undefined,
      sanityFlags: [],
      scoredAt: undefined,
      scoredByVersion: undefined,
    };
    target.flight = flight;
    savedFlight = flight;

    await writePrivateJson(path, RoundSchema, current, leaseId);
  });

  // Supersede: delete the superseded IGC track outside the lease. Only when the
  // slot actually carried an IGC path — a manual-over-manual overwrite has none.
  if (oldIgcPath) {
    await getPrivateBlockBlobClient(oldIgcPath).deleteIfExists();
  }

  return { status: 200, jsonBody: savedFlight };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("recordManualFlight", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots/{place}/manual-flight",
  handler: withErrorHandler(recordManualFlight),
});
