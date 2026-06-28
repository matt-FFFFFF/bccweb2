import { randomUUID } from "node:crypto";
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { Round, RoundBrief } from "@bccweb/types";
import { BriefSchema, RoundSchema } from "@bccweb/schemas";
import {
  getPrivateBlobClient,
  withPrivateLease,
} from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { getActiveWording } from "../lib/signTofly/wording.js";
import {
  buildSignaturePayload,
  getLatestSignature,
  listSignaturesForRound,
  overrideSignaturePath,
  readSignature,
  signaturePath,
  writeSignature,
  writeSignatureToPath,
} from "../lib/signTofly/ledger.js";
import { appendAuditLine } from "../lib/signTofly/auditLog.js";

type RoundBriefWithVersion = RoundBrief & { version?: number };

async function signOwnSlot(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (caller.roles.includes("Admin") || caller.roles.includes("RoundsCoord")) {
    throw new HttpError(403, "NOT_YOUR_SLOT_USE_OVERRIDE");
  }
  if (!caller.roles.includes("Pilot") || !caller.pilotId) {
    throw new HttpError(403, "NOT_YOUR_SLOT");
  }

  const { roundId, teamId, place } = req.params as {
    roundId?: string;
    teamId?: string;
    place?: string;
  };
  if (!roundId || !teamId || !place) {
    throw new HttpError(400, "MISSING_IDS", "Missing round, team, or place");
  }
  const placeNum = Number(place);
  if (!Number.isInteger(placeNum)) {
    throw new HttpError(400, "INVALID_PLACE", "place must be a number");
  }

  const round = await readRound(roundId);
  const slot = findSlot(round, teamId, placeNum);
  if (slot?.pilotId !== caller.pilotId) {
    throw new HttpError(403, "NOT_YOUR_SLOT");
  }
  if (round.status !== "BriefComplete") {
    throw new HttpError(409, "INVALID_STATE", `Round status is ${round.status}`);
  }
  if (slot.status !== "Filled") {
    throw new HttpError(409, "SLOT_EMPTY");
  }

  const [wording, brief] = await Promise.all([
    getActiveWording(),
    readRoundBrief(roundId),
  ]);
  const briefVersion = brief.version ?? 1;
  const existing = await readSignature(roundId, teamId, placeNum, briefVersion);
  if (existing) {
    await reflectCurrentSignature(roundId, teamId, placeNum, briefVersion);
    return { status: 200, jsonBody: existing };
  }

  const sig = buildSignaturePayload({
    id: randomUUID(),
    roundId,
    teamId,
    place: placeNum,
    pilotId: caller.pilotId,
    userId: caller.userId,
    signedAt: new Date().toISOString(),
    brief,
    wording,
    req,
    source: "pilot-self",
  });

  await writeSignature(sig);
  await reflectCurrentSignature(roundId, teamId, placeNum, briefVersion);
  return { status: 201, jsonBody: sig };
}

async function overrideSlotSignature(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const { roundId, teamId, place } = req.params as {
    roundId?: string;
    teamId?: string;
    place?: string;
  };
  if (!roundId || !teamId || !place) {
    throw new HttpError(400, "MISSING_IDS", "Missing round, team, or place");
  }
  const placeNum = Number(place);
  if (!Number.isInteger(placeNum)) {
    throw new HttpError(400, "INVALID_PLACE", "place must be a number");
  }

  const body = await req.json() as { reason?: unknown; onBehalfOfPilotId?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 20) {
    throw new HttpError(400, "INVALID_REASON", "Reason must be at least 20 characters");
  }
  const onBehalfOfPilotId = typeof body.onBehalfOfPilotId === "string"
    ? body.onBehalfOfPilotId
    : "";

  const round = await readRound(roundId);
  const isAdmin = caller.roles.includes("Admin");
  const isScopedCoord = caller.roles.includes("RoundsCoord") &&
    caller.clubId !== null &&
    round.organisingClub?.id === caller.clubId;
  if (!isAdmin && !isScopedCoord) {
    throw new HttpError(403, "FORBIDDEN");
  }

  const slot = findSlot(round, teamId, placeNum);
  if (!slot) throw new HttpError(404, "NOT_FOUND", "Pilot slot not found");
  if (slot.pilotId !== onBehalfOfPilotId) {
    throw new HttpError(400, "PILOT_MISMATCH", "onBehalfOfPilotId does not match the slot's assigned pilot");
  }
  if (round.status !== "BriefComplete") {
    throw new HttpError(409, "INVALID_STATE", `Round status is ${round.status}`);
  }
  if (slot.status !== "Filled") {
    throw new HttpError(409, "SLOT_EMPTY");
  }

  const [wording, brief] = await Promise.all([
    getActiveWording(),
    readRoundBrief(roundId),
  ]);
  const briefVersion = brief.version ?? 1;
  const existing = await readSignature(roundId, teamId, placeNum, briefVersion);
  const sig = buildSignaturePayload({
    id: randomUUID(),
    roundId,
    teamId,
    place: placeNum,
    pilotId: onBehalfOfPilotId,
    userId: caller.userId,
    signedAt: new Date().toISOString(),
    brief,
    wording,
    req,
    source: "coord-override",
    overrideBy: caller.userId,
    overrideReason: reason,
  });

  const path = overrideSignaturePath(roundId, teamId, placeNum, briefVersion, randomUUID().slice(0, 8));
  await writeSignatureToPath(sig, path);
  await appendAuditLine("sign-override", {
    ...sig,
    audit: {
      whenAdded: sig.signedAt,
      signaturePath: path,
      originalSignaturePathIfAny: existing
        ? signaturePath(roundId, teamId, placeNum, briefVersion)
        : null,
      originalSignatureSourceIfAny: existing?.source ?? null,
      pilotAndCoordSigned: Boolean(existing && existing.source !== "coord-override"),
    },
  });
  await reflectCurrentSignature(roundId, teamId, placeNum, briefVersion);

  return { status: 201, jsonBody: sig };
}

async function getRoundSignatures(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const roundId = req.params["roundId"];
  if (!roundId) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const round = await readRound(roundId);
  const isAdmin = caller.roles.includes("Admin");
  const isScopedCoord = caller.roles.includes("RoundsCoord") &&
    caller.clubId !== null &&
    round.organisingClub?.id === caller.clubId;
  if (!isAdmin && !isScopedCoord) {
    throw new HttpError(403, "FORBIDDEN");
  }

  const signatures = await listSignaturesForRound(roundId);
  signatures.sort((a, b) =>
    a.teamId.localeCompare(b.teamId) ||
    a.place - b.place ||
    ((a.briefVersion ?? 0) - (b.briefVersion ?? 0)),
  );
  return { status: 200, jsonBody: signatures };
}

async function readRound(roundId: string): Promise<Round> {
  const path = `rounds/${roundId}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw err;
  }
}

async function readRoundBrief(roundId: string): Promise<RoundBriefWithVersion> {
  const path = `round-briefs/${roundId}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), BriefSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "BRIEF_NOT_FOUND", "Round brief not found");
    }
    throw err;
  }
}

function findSlot(round: Round, teamId: string, place: number) {
  const team = round.teams.find((candidate) => candidate.id === teamId);
  return team?.pilots.find((slot) => slot.placeInTeam === place) ?? null;
}

async function reflectCurrentSignature(
  roundId: string,
  teamId: string,
  place: number,
  currentBriefVersion: number,
): Promise<void> {
  const latest = await getLatestSignature(roundId, teamId, place);
  if (latest?.briefVersion !== currentBriefVersion) return;

  const path = `rounds/${roundId}.json`;
  await withPrivateLease(path, async (leaseId) => {
    const round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
    const slot = findSlot(round, teamId, place);
    if (!slot) throw new HttpError(404, "NOT_FOUND", "Pilot slot not found");
    if (!slot.signToFly) {
      slot.signToFly = true;
      await writePrivateJson(path, RoundSchema, round, leaseId);
    }
  });
}

app.http("signOwnSlot", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{roundId}/teams/{teamId}/pilots/{place}/sign",
  handler: withErrorHandler(signOwnSlot),
});

app.http("getRoundSignatures", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rounds/{roundId}/signatures",
  handler: withErrorHandler(getRoundSignatures),
});

app.http("overrideSlotSignature", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{roundId}/teams/{teamId}/pilots/{place}/sign-override",
  handler: withErrorHandler(overrideSlotSignature),
});
