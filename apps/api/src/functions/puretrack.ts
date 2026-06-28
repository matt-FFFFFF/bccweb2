/**
 * PureTrack endpoints — Phase 4
 *
 * POST /api/rounds/{id}/puretrack/create-groups
 *   Manually (re-)creates PureTrack groups for a locked round.
 *   Auth: RoundsCoord or Admin only.
 *
 * GET /api/manage/puretrack/groups?roundId={id}
 *   Lists persisted PureTrackGroup records for a round.
 *   Auth: Admin, or RoundsCoord scoped to the round's organising club.
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { BlobServiceClient } from "@azure/storage-blob";
import type { Round, Pilot, PureTrackGroup } from "@bccweb/types";
import { PilotSchema, RoundSchema } from "@bccweb/schemas";
import { getPrivateBlobClient, withPrivateLease } from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import {
  createPureTrackGroups,
  PureTrackRoundResult,
} from "../lib/puretrack.js";

function isCoord(roles: string[]): boolean {
  return roles.includes("RoundsCoord") || roles.includes("Admin");
}

function isAdmin(roles: string[]): boolean {
  return roles.includes("Admin");
}

// ─── Private container accessor (listing only) ────────────────────────────────

function getPrivateContainerClient() {
  const conn = process.env["BLOB_CONNECTION_STRING"];
  if (!conn) throw new Error("BLOB_CONNECTION_STRING is not set");
  const svc = BlobServiceClient.fromConnectionString(conn);
  const name = process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private";
  return svc.getContainerClient(name);
}

async function listPureTrackGroupsForRound(roundId: string): Promise<PureTrackGroup[]> {
  const container = getPrivateContainerClient();
  const groups: PureTrackGroup[] = [];

  for await (const item of container.listBlobsFlat({ prefix: "puretrack-groups/" })) {
    if (!item.name.endsWith(".json")) continue;
    try {
      const blobClient = container.getBlobClient(item.name);
      const response = await blobClient.download();
      const chunks: Buffer[] = [];
      for await (const chunk of response.readableStreamBody!) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as PureTrackGroup;
      if (data.roundId === roundId) {
        groups.push(data);
      }
    } catch {
      // skip unreadable blobs
    }
  }

  return groups;
}

// ─── POST /api/rounds/{id}/puretrack/create-groups ───────────────────────────

async function createPureTrackGroupsHandler(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  let round: Round;
  try {
    const roundPath = `rounds/${id}.json`;
    round = await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  if (!isAdmin(caller.roles) && round.organisingClub?.id !== caller.clubId) {
    return forbiddenResponse();
  }

  await mutationRateLimit(req, caller, "createPureTrackGroups", "heavy");

  if (round.status !== "Locked" && round.status !== "Complete") {
    return {
      status: 409,
      jsonBody: {
        error: `PureTrack groups can only be created for Locked or Complete rounds (currently ${round.status})`,
      },
    };
  }

  const pilotIds = round.teams.flatMap((t) =>
    t.pilots
      .filter((s) => s.status === "Filled" && s.pilotId)
      .map((s) => s.pilotId!)
  );
  const uniquePilotIds = [...new Set(pilotIds)];

  const pilotPureTrackIds = new Map<string, number>();
  await Promise.all(
    uniquePilotIds.map(async (pilotId) => {
      try {
        const pilotPath = `pilots/${pilotId}.json`;
        const pilot = await readJson(
          getPrivateBlobClient(pilotPath),
          PilotSchema,
          pilotPath,
        );
        if (pilot.pureTrackId != null) {
          pilotPureTrackIds.set(pilotId, pilot.pureTrackId);
        }
      } catch {
        // pilot not found — skip
      }
    })
  );

  let result: PureTrackRoundResult | null;
  try {
    result = await createPureTrackGroups(round, pilotPureTrackIds, {
      callerUserId: caller.userId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[puretrack] createPureTrackGroups failed for round ${id}:`, err);
    throw new HttpError(502, "PURETRACK_UPSTREAM_ERROR", msg);
  }

  const path = `rounds/${id}.json`;
  if (!result) {
    return { status: 200, jsonBody: null };
  }
  try {
    await withPrivateLease(path, async (leaseId) => {
      const r = await readJson(getPrivateBlobClient(path), RoundSchema, path);
      r.pureTrackGroupId = result.roundGroupId;
      r.pureTrackGroupName = result.roundGroupName;
      r.pureTrackGroupSlug = result.roundGroupSlug;
      for (const team of r.teams) {
        const teamResult = result.teams.find((t) => t.teamId === team.id);
        if (teamResult) {
          team.pureTrackGroupId = teamResult.groupId;
          team.pureTrackGroupSlug = teamResult.groupSlug;
        }
      }
      await writePrivateJson(path, RoundSchema, r, leaseId);
    });
  } catch (err) {
    // Not fatal — groups were created, IDs just didn't persist; log and continue
    console.error(`[puretrack] Failed to persist group IDs for round ${id}:`, err);
  }

  return { status: 200, jsonBody: result };
}

// ─── GET /api/manage/puretrack/groups ─────────────────────────────────────────

async function listPureTrackGroupsHandler(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const roundId = req.query.get("roundId");
  if (!roundId) throw new HttpError(400, "MISSING_ROUND_ID", "roundId query parameter is required");

  if (!isAdmin(caller.roles)) {
    // RoundsCoord: verify they belong to the round's organising club
    let round: Round;
    try {
      const roundPath = `rounds/${roundId}.json`;
      round = await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        throw new HttpError(404, "NOT_FOUND", "Round not found");
      }
      throw new HttpError(500, "INTERNAL");
    }

    if (!round.organisingClub || round.organisingClub.id !== caller.clubId) {
      return forbiddenResponse();
    }
  }

  const groups = await listPureTrackGroupsForRound(roundId);
  return { status: 200, jsonBody: groups };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("createPureTrackGroups", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/puretrack/create-groups",
  handler: withErrorHandler(createPureTrackGroupsHandler),
});

app.http("listPureTrackGroups", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "manage/puretrack/groups",
  handler: withErrorHandler(listPureTrackGroupsHandler),
});
