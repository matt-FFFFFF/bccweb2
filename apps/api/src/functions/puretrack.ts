// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
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
import { randomUUID } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import type { Round, PureTrackGroup } from "@bccweb/types";
import { RoundSchema } from "@bccweb/schemas";
import { getPrivateBlobClient } from "../lib/blob.js";
import { readJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import { setPureTrackStatus } from "../lib/puretrackStatus.js";
import { enqueuePureTrackGroupJob } from "../lib/queue.js";

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

  const attemptId = randomUUID();
  const { updated, previousStatus } = await setPureTrackStatus(id, "pending", {
    newAttemptId: attemptId,
    requireRoundStatuses: ["Locked", "Complete"],
    rejectStatuses: ["pending", "processing"],
  });
  if (!updated) {
    if (previousStatus === "pending" || previousStatus === "processing") {
      throw new HttpError(
        409,
        "PURETRACK_IN_PROGRESS",
        "PureTrack group creation is already in progress",
      );
    }
    throw new HttpError(
      409,
      "CONFLICT",
      "PureTrack groups can only be created for Locked or Complete rounds",
    );
  }

  try {
    await enqueuePureTrackGroupJob({ roundId: id, attemptId });
  } catch (error: unknown) {
    await setPureTrackStatus(id, "failed", {
      error: "enqueue_failed",
      expectAttemptId: attemptId,
      fromStatuses: ["pending", "processing"],
    }).catch(() => {});
    throw error;
  }

  return { status: 202, jsonBody: { status: "pending" } };
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
