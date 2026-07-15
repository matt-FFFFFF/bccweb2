// SPDX-FileCopyrightText: 2026 British Club Challenge authors
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
import type {
  CallerIdentity,
  Flight,
  FlightValidation,
  PilotSlot,
  Round,
} from "@bccweb/types";
import { RoundSchema } from "@bccweb/schemas";
import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  readBlob,
  withPrivateLeaseRenewing,
} from "../lib/blob.js";
import { writePrivateJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { scoreIgc } from "../lib/igcScoring.js";
import {
  findSlot,
  loadConfig,
  readRoundOr404,
  resolveExpectedPilotName,
  streamToBuffer,
} from "../lib/flightHelpers.js";
import { enqueueIgcValidation } from "../lib/igcValidationJob.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import { recomputeSeason, updateRoundsIndex } from "../lib/recompute.js";
import { scoreRoundEnforcingValidation } from "../lib/scoreRoundValidated.js";

// Raw IGC uploads are plain-text B-record logs; a real track is a few hundred KB.
const MAX_IGC_BYTES = 15 * 1024 * 1024;
const FAI_SIGNATURE_VALIDATION_MAX_BYTES = 3_000_000;
// Every valid IGC file begins with an "A" (manufacturer) record — byte 'A' (0x41).
const IGC_FIRST_BYTE = 0x41;

// ─── Shared helpers (reused by T10 GET / T11 DELETE) ────────────────────────────

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

function canDeleteSlotIgc(caller: CallerIdentity, round: Round): boolean {
  if (caller.roles.includes("Admin")) return true;
  return (
    caller.roles.includes("RoundsCoord") &&
    caller.clubId !== null &&
    round.organisingClub?.id === caller.clubId
  );
}

function canRemediateSlotIgc(caller: CallerIdentity, round: Round): boolean {
  return canDeleteSlotIgc(caller, round);
}

function preservedValidationState(validation: FlightValidation | undefined): FlightValidation {
  return {
    date: validation?.date,
    overridden: validation?.overridden,
    overriddenBy: validation?.overriddenBy,
    overriddenAt: validation?.overriddenAt,
  };
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

  // Empty-slot gate: an Admin/coord may target a pilotless slot — reject before any
  // scoring or blob write (a null pilotId would otherwise build `.../null.igc`).
  if (!slot.pilotId) {
    throw new HttpError(
      409,
      "SLOT_NOT_FILLED",
      "Cannot record a flight on an empty slot",
    );
  }

  await mutationRateLimit(req, caller, "uploadIgc", "flights");

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
  const config = await loadConfig();
  if (
    config.flightSignatureValidationEnabled &&
    buffer.length > FAI_SIGNATURE_VALIDATION_MAX_BYTES
  ) {
    throw new HttpError(
      413,
      "IGC_TOO_LARGE_FOR_VALIDATION",
      "IGC exceeds the 3 MB FAI signature-validation limit",
    );
  }

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

  const flightId = randomUUID();
  const validationAttemptId = config.flightSignatureValidationEnabled
    ? randomUUID()
    : undefined;
  const igcPath = `flight-igcs/${id}/${slot.pilotId}/${flightId}.igc`;
  await getPrivateBlockBlobClient(igcPath).upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" },
  });

  const validation: FlightValidation = {};
  if (config.flightDateValidationEnabled) {
    validation.date = scored.sanityFlags.includes("IGC_DATE_MISMATCH")
      ? "invalid"
      : "valid";
  }
  if (validationAttemptId) {
    validation.signature = "pending";
    validation.validationAttemptId = validationAttemptId;
  }

  const flight: Flight = {
    id: flightId,
    distance: scored.distance,
    igcPath,
    sanityFlags: scored.sanityFlags,
    scoredAt: scored.scoredAt,
    scoredByVersion: scored.scoredByVersion,
    scoringType: "XC",
    isManualLog: false,
    validation:
      config.flightDateValidationEnabled || validationAttemptId
        ? validation
        : undefined,
    // Placeholders — the pilot/team score is derived later by scoreRound(), NOT here.
    wingFactor: 0,
    score: 0,
  };

  let supersededIgcPath: string | undefined;
  let saved: Flight;
  try {
    saved = await withPrivateLeaseRenewing(roundPath, async (leaseId) => {
      // Raw read (NOT readJson): this lease transaction must observe the exact current
      // slot before replacing it, including an IGC committed by a concurrent upload.
      const current = (await readBlob(getPrivateBlobClient(roundPath))) as Round;
      if (current.status !== "Locked") {
        throw new HttpError(
          409,
          "ROUND_NOT_LOCKED",
          `Round status is ${current.status}`,
        );
      }
      const currentSlot = findSlot(current, teamId, place);
      if (!currentSlot || currentSlot.pilotId !== slot.pilotId) {
        throw new HttpError(404, "NOT_FOUND", "Pilot slot changed during upload");
      }
      if (!canWriteSlotIgc(caller, current, currentSlot)) {
        throw new HttpError(403, "FORBIDDEN", "Not permitted to upload this IGC");
      }
      if (current.date !== round.date) {
        throw new HttpError(
          409,
          "ROUND_DATE_CHANGED",
          "Round date changed during IGC scoring; retry the upload",
        );
      }
      supersededIgcPath = currentSlot.flight?.igcPath;
      currentSlot.flight = flight;
      await writePrivateJson(roundPath, RoundSchema, current, leaseId);
      return flight;
    });
  } catch (error: unknown) {
    await getPrivateBlockBlobClient(igcPath).deleteIfExists();
    throw error;
  }

  if (validationAttemptId) {
    try {
      await enqueueIgcValidation({
        roundId: id,
        teamId,
        place,
        flightId,
        validationAttemptId,
      });
    } catch {
      let fallbackApplied = false;
      await withPrivateLeaseRenewing(roundPath, async (leaseId) => {
        const current = (await readBlob(getPrivateBlobClient(roundPath))) as Round;
        const currentFlight = findSlot(current, teamId, place)?.flight;
        if (
          currentFlight?.id !== flightId ||
          currentFlight.validation?.validationAttemptId !== validationAttemptId
        ) {
          return;
        }
        currentFlight.validation = {
          ...currentFlight.validation,
          signature: "unverified",
          faiStatus: "ENQUEUE_FAILED",
        };
        await writePrivateJson(roundPath, RoundSchema, current, leaseId);
        fallbackApplied = true;
      });
      if (fallbackApplied && saved.validation) {
        saved.validation.signature = "unverified";
        saved.validation.faiStatus = "ENQUEUE_FAILED";
      }
    }
  }

  if (supersededIgcPath && supersededIgcPath !== igcPath) {
    try {
      await getPrivateBlockBlobClient(supersededIgcPath).deleteIfExists();
    } catch (error: unknown) {
      _ctx.warn(
        "Superseded IGC cleanup failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }

  return { status: 200, jsonBody: saved };
}

async function getIgc(
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

  const igcPath = slot.flight?.igcPath;
  if (!igcPath) {
    throw new HttpError(404, "NOT_FOUND", "IGC not found");
  }

  const blobClient = getPrivateBlobClient(igcPath);
  let downloadRes: Awaited<ReturnType<typeof blobClient.download>>;
  try {
    downloadRes = await blobClient.download();
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "IGC not found");
    }
    throw err;
  }

  const readableStreamBody = downloadRes.readableStreamBody;
  if (!readableStreamBody) {
    throw new HttpError(500, "IGC_DOWNLOAD_FAILED", "IGC download returned no body");
  }
  const body = await streamToBuffer(readableStreamBody);
  return {
    status: 200,
    body,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="bcc-${id}-team-${teamId}-pilot-${place}.igc"`,
      "Cache-Control": "private, max-age=300",
    },
  };
}

async function deleteIgc(
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

  if (!canDeleteSlotIgc(caller, round)) return forbiddenResponse();

  if (round.status !== "Locked") {
    throw new HttpError(409, "ROUND_NOT_LOCKED", `Round status is ${round.status}`);
  }

  if (!slot.flight?.igcPath) {
    throw new HttpError(404, "NOT_FOUND", "IGC not found");
  }

  await mutationRateLimit(req, caller, "deleteIgc", "flights");

  let oldPath = "";
  await withPrivateLeaseRenewing(roundPath, async (leaseId) => {
    const current = (await readBlob(getPrivateBlobClient(roundPath))) as Round;
    const currentSlot = findSlot(current, teamId, place);
    if (!currentSlot) throw new HttpError(404, "NOT_FOUND", "Pilot slot not found");
    if (!currentSlot.flight?.igcPath) {
      throw new HttpError(404, "NOT_FOUND", "IGC not found");
    }
    oldPath = currentSlot.flight.igcPath;
    currentSlot.flight = null;
    currentSlot.pilotPoints = 0;
    await writePrivateJson(roundPath, RoundSchema, current, leaseId);
  });

  await getPrivateBlockBlobClient(oldPath).deleteIfExists();
  return { status: 204 };
}

async function revalidateIgc(
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
  if (!canRemediateSlotIgc(caller, round)) return forbiddenResponse();

  const config = await loadConfig();
  if (!config.flightSignatureValidationEnabled) {
    throw new HttpError(
      409,
      "SIGNATURE_VALIDATION_DISABLED",
      "IGC signature validation is disabled",
    );
  }

  await mutationRateLimit(req, caller, "revalidateIgc", "flights");
  const validationAttemptId = randomUUID();
  let currentFlightId = "";
  let savedFlight = await withPrivateLeaseRenewing(roundPath, async (leaseId) => {
    const current = (await readBlob(getPrivateBlobClient(roundPath))) as Round;
    if (!canRemediateSlotIgc(caller, current)) {
      throw new HttpError(403, "FORBIDDEN", "Not permitted to revalidate this IGC");
    }
    const flight = findSlot(current, teamId, place)?.flight;
    if (!flight?.igcPath) {
      throw new HttpError(404, "NOT_FOUND", "IGC not found");
    }
    if (flight.isManualLog) {
      throw new HttpError(
        409,
        "MANUAL_FLIGHT_NOT_REVALIDATABLE",
        "Manual flights cannot be signature revalidated",
      );
    }
    currentFlightId = flight.id;
    flight.validation = {
      ...preservedValidationState(flight.validation),
      signature: "pending",
      validationAttemptId,
    };
    await writePrivateJson(roundPath, RoundSchema, current, leaseId);
    return flight;
  });

  try {
    await enqueueIgcValidation({
      roundId: id,
      teamId,
      place,
      flightId: currentFlightId,
      validationAttemptId,
    });
  } catch {
    const fallbackRound = await withPrivateLeaseRenewing(roundPath, async (leaseId) => {
      const current = (await readBlob(getPrivateBlobClient(roundPath))) as Round;
      const flight = findSlot(current, teamId, place)?.flight;
      if (
        flight?.id !== currentFlightId ||
        flight.validation?.validationAttemptId !== validationAttemptId
      ) {
        return null;
      }
      flight.validation = {
        ...preservedValidationState(flight.validation),
        signature: "unverified",
        validationAttemptId,
        faiStatus: "ENQUEUE_FAILED",
      };
      const { round: scored, derivation } = scoreRoundEnforcingValidation(
        current,
        await loadConfig(),
      );
      scored.scoring = { scoredAt: new Date().toISOString(), ...derivation };
      await writePrivateJson(roundPath, RoundSchema, scored, leaseId);
      return scored;
    });
    if (fallbackRound) {
      savedFlight = {
        ...savedFlight,
        validation: {
          ...preservedValidationState(savedFlight.validation),
          signature: "unverified",
          validationAttemptId,
          faiStatus: "ENQUEUE_FAILED",
        },
      };
      await updateRoundsIndex(fallbackRound);
      if (fallbackRound.status === "Complete") {
        await recomputeSeason(fallbackRound.season.year);
      }
    }
  }

  return { status: 200, jsonBody: savedFlight };
}

async function allowIgc(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();

  const id = req.params["id"];
  const teamId = req.params["teamId"];
  const place = parseInt(req.params["place"] ?? "", 10);
  if (!id || !teamId || !Number.isInteger(place)) {
    throw new HttpError(400, "MISSING_IDS", "Missing round, team, or place");
  }

  await mutationRateLimit(req, caller, "allowIgc", "flights");
  const roundPath = `rounds/${id}.json`;
  await readRoundOr404(roundPath);
  const saved = await withPrivateLeaseRenewing(roundPath, async (leaseId) => {
    const current = (await readBlob(getPrivateBlobClient(roundPath))) as Round;
    const flight = findSlot(current, teamId, place)?.flight;
    if (!flight) throw new HttpError(404, "NOT_FOUND", "Flight not found");
    const validation = flight.validation;
    const isDefinitivelyInvalid =
      validation?.signature === "invalid" || validation?.date === "invalid";
    if (
      flight.isManualLog ||
      (validation?.overridden !== true && !isDefinitivelyInvalid)
    ) {
      throw new HttpError(
        409,
        "FLIGHT_NOT_ALLOWABLE",
        "Only a non-manual invalid flight can be allowed",
      );
    }
    if (validation?.overridden !== true) {
      flight.validation = {
        ...validation,
        overridden: true,
        overriddenBy: caller.userId,
        overriddenAt: new Date().toISOString(),
      };
    }
    const { round: scored, derivation } = scoreRoundEnforcingValidation(
      current,
      await loadConfig(),
    );
    scored.scoring = { scoredAt: new Date().toISOString(), ...derivation };
    await writePrivateJson(roundPath, RoundSchema, scored, leaseId);
    return { round: scored, flight };
  });

  await updateRoundsIndex(saved.round);
  if (saved.round.status === "Complete") {
    try {
      await recomputeSeason(saved.round.season.year);
    } catch {
      throw new HttpError(
        503,
        "SEASON_RECOMPUTE_FAILED",
        "The override was saved; retry to publish season results",
      );
    }
  }

  return { status: 200, jsonBody: saved.flight };
}

// ─── Registration ───────────────────────────────────────────────────────────────

app.http("uploadIgc", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots/{place}/igc",
  handler: withErrorHandler(uploadIgc),
});

app.http("getIgc", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots/{place}/igc",
  handler: withErrorHandler(getIgc),
});

app.http("deleteIgc", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots/{place}/igc",
  handler: withErrorHandler(deleteIgc),
});

app.http("revalidateIgc", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots/{place}/igc/revalidate",
  handler: withErrorHandler(revalidateIgc),
});

app.http("allowIgc", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots/{place}/igc/allow",
  handler: withErrorHandler(allowIgc),
});
