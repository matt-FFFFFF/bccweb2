import { randomUUID } from "node:crypto";
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { Round, RoundBrief, Signature } from "@bccweb/types";
import {
  getPrivateBlobClient,
  readBlob,
  writePrivateBlob,
  withPrivateLease,
} from "../lib/blob.js";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { computeBriefHash } from "../lib/signTofly/briefVersion.js";
import { getActiveWording } from "../lib/signTofly/wording.js";
import {
  getLatestSignature,
  listSignaturesForRound,
  readSignature,
  writeSignature,
} from "../lib/signTofly/ledger.js";

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

  const sig: Signature = {
    id: randomUUID(),
    roundId,
    teamId,
    place: placeNum,
    pilotId: caller.pilotId,
    userId: caller.userId,
    signedAt: new Date().toISOString(),
    briefVersion,
    briefHash: computeBriefHash(brief),
    wordingVersion: wording.version,
    wordingHash: wording.hash,
    ip: extractIp(req),
    userAgent: req.headers.get("user-agent") ?? null,
    source: "pilot-self",
  };

  await writeSignature(sig);
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

export function extractIp(req: HttpRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() ?? null;
  return req.headers.get("x-azure-clientip") ?? null;
}

async function readRound(roundId: string): Promise<Round> {
  try {
    return await readBlob<Round>(getPrivateBlobClient(`rounds/${roundId}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw err;
  }
}

async function readRoundBrief(roundId: string): Promise<RoundBriefWithVersion> {
  try {
    return await readBlob<RoundBriefWithVersion>(
      getPrivateBlobClient(`round-briefs/${roundId}.json`),
    );
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
    const round = await readBlob<Round>(getPrivateBlobClient(path));
    const slot = findSlot(round, teamId, place);
    if (!slot) throw new HttpError(404, "NOT_FOUND", "Pilot slot not found");
    if (!slot.signToFly) {
      slot.signToFly = true;
      await writePrivateBlob(path, round, leaseId);
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
