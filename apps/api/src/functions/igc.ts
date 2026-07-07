// SPDX-License-Identifier: MPL-2.0
/**
 * Flight IGC endpoints — internalised XC scoring
 *
 * POST /api/rounds/{id}/teams/{teamId}/pilots/{place}/igc
 *   — upload a pilot's IGC track, score it with scoreIgc(), store the raw file,
 *     and stamp the derived Flight onto the round slot.
 *
 * T10 (GET) and T11 (DELETE) append their handlers below the uploadIgc handler
 * and register alongside it at the bottom of this file — keep the shared helpers
 * (findSlot / role gate / pilot-name resolution) reusable for those handlers.
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "node:crypto";
import type { CallerIdentity, Flight, PilotSlot, Round } from "@bccweb/types";
import { PilotSchema, RoundSchema } from "@bccweb/schemas";
import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  readBlob,
  withPrivateLeaseRenewing,
} from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { scoreIgc } from "../lib/igcScoring.js";

// Raw IGC uploads are plain-text B-record logs; a real track is a few hundred KB.
const MAX_IGC_BYTES = 15 * 1024 * 1024;
// Every valid IGC file begins with an "A" (manufacturer) record — byte 'A' (0x41).
const IGC_FIRST_BYTE = 0x41;

// ─── Shared helpers (reused by T10 GET / T11 DELETE) ────────────────────────────

/** Locate a slot by its 1-based `placeInTeam` within `teamId`. */
function findSlot(round: Round, teamId: string, place: number): PilotSlot | null {
  const team = round.teams.find((candidate) => candidate.id === teamId);
  return team?.pilots.find((slot) => slot.placeInTeam === place) ?? null;
}

/**
 * IGC write access: an Admin unconditionally, a RoundsCoord scoped to the
 * organising club, or the Pilot who owns the slot. Mirrors the sign-to-fly /
 * brief-image gates.
 */
function canWriteSlotIgc(
  caller: CallerIdentity,
  round: Round,
  slot: PilotSlot,
): boolean {
  if (caller.roles.includes("Admin")) return true;
  if (
    caller.roles.includes("RoundsCoord") &&
    caller.clubId !== null &&
    round.organisingClub?.id === caller.clubId
  ) {
    return true;
  }
  return (
    caller.roles.includes("Pilot") &&
    caller.pilotId !== null &&
    slot.pilotId === caller.pilotId
  );
}

/**
 * Best-effort expected pilot name for the IGC_PILOT_MISMATCH sanity check. The
 * round slot's `snapshot` does NOT carry a name, so resolve it from the pilot
 * blob; any miss (unlinked slot, absent/corrupt blob) yields `undefined`, which
 * scoreIgc treats as "skip the name check".
 */
async function resolveExpectedPilotName(
  pilotId: string | null,
): Promise<string | undefined> {
  if (!pilotId) return undefined;
  const path = `pilots/${pilotId}.json`;
  try {
    const pilot = await readJson(getPrivateBlobClient(path), PilotSchema, path);
    return pilot.person.fullName || undefined;
  } catch {
    return undefined;
  }
}

async function readRoundOr404(roundPath: string): Promise<Round> {
  try {
    return await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw err;
  }
}

// ─── POST /api/rounds/{id}/teams/{teamId}/pilots/{place}/igc ─────────────────────

async function uploadIgc(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  const teamId = req.params["teamId"];
  const place = parseInt(req.params["place"] ?? "", 10);
  if (!id || !teamId || !Number.isInteger(place)) {
    throw new HttpError(400, "MISSING_IDS", "Missing round, team, or place");
  }

  const roundPath = `rounds/${id}.json`;
  const round = await readRoundOr404(roundPath);

  const slot = findSlot(round, teamId, place);
  if (!slot) throw new HttpError(404, "NOT_FOUND", "Pilot slot not found");

  if (!canWriteSlotIgc(caller, round, slot)) return forbiddenResponse();

  if (round.status !== "Locked") {
    throw new HttpError(409, "ROUND_NOT_LOCKED", `Round status is ${round.status}`);
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "BAD_REQUEST", "Missing file");
  }
  if (file.size > MAX_IGC_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Max 15MB");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer[0] !== IGC_FIRST_BYTE) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Not an IGC file");
  }

  const expectedPilotName = await resolveExpectedPilotName(slot.pilotId);

  let scored: Awaited<ReturnType<typeof scoreIgc>>;
  try {
    scored = await scoreIgc({
      buffer,
      expectedDate: round.date,
      expectedPilotName,
    });
  } catch {
    // scoreIgc already catches parse throws (→ distance 0 + NO_SCORING_SOLUTION);
    // a genuine throw here is an unexpected failure of the scorer itself.
    throw new HttpError(400, "IGC_PARSE_ERROR", "Could not score IGC file");
  }

  // Overwrite implicit — a re-upload replaces the prior track at the same path.
  const igcPath = `flight-igcs/${id}/${slot.pilotId}.igc`;
  await getPrivateBlockBlobClient(igcPath).upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" },
  });

  const flight: Flight = {
    id: randomUUID(),
    distance: scored.distance,
    igcPath,
    sanityFlags: scored.sanityFlags,
    scoredAt: scored.scoredAt,
    scoredByVersion: scored.scoredByVersion,
    scoringType: "XC",
    isManualLog: false,
    // Placeholders — the pilot/team score is derived later by scoreRound(), NOT here.
    wingFactor: 0,
    score: 0,
  };

  const saved = await withPrivateLeaseRenewing(roundPath, async (leaseId) => {
    // Raw read (NOT readJson): FlightSchema.strip() drops igcPath/sanityFlags on a
    // schema read, so re-reading via RoundSchema here would wipe OTHER slots' IGC
    // results on write-back. Read raw, mutate, write (observe-mode preserves keys).
    const current = (await readBlob(getPrivateBlobClient(roundPath))) as Round;
    const currentSlot = findSlot(current, teamId, place);
    if (!currentSlot) throw new HttpError(404, "NOT_FOUND", "Pilot slot not found");
    currentSlot.flight = flight;
    await writePrivateJson(roundPath, RoundSchema, current, leaseId);
    return flight;
  });

  return { status: 200, jsonBody: saved };
}

// ─── Registration ───────────────────────────────────────────────────────────────

app.http("uploadIgc", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots/{place}/igc",
  handler: withErrorHandler(uploadIgc),
});
