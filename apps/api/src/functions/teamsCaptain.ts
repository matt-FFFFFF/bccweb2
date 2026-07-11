// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * PUT /api/rounds/{id}/teams/{teamId}/captain
 *
 * Manual captain override — Admin or (RoundsCoord scoped to the target
 * team's club). Blocked once the roster is frozen — i.e. any status
 * past Confirmed (BriefComplete, Locked, Complete) and Cancelled — via
 * isRosterFrozen(status).
 *
 * Body: { pilotId: string | null }
 * - If pilotId is non-null the pilot must be a Filled member of the team.
 * - Passing null clears the captain.
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { Round } from "@bccweb/types";
import { isRosterFrozen, rosterFrozenReason } from "@bccweb/types";
import { RoundSchema } from "@bccweb/schemas";
import {
  getPrivateBlobClient,
  withPrivateLeaseRetry,
} from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";

// ─── Handler ──────────────────────────────────────────────────────────────────

async function setTeamCaptain(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const isAdmin = caller.roles.includes("Admin");
  const isCoord = caller.roles.includes("RoundsCoord");
  if (!isAdmin && !isCoord) return forbiddenResponse();

  const { id, teamId } = req.params as { id?: string; teamId?: string };
  if (!id || !teamId) {
    throw new HttpError(400, "MISSING_IDS", "Missing round or team id");
  }

  const path = `rounds/${id}.json`;

  if (isCoord && !isAdmin) {
    // Authorization-only pre-read; the leased read below remains authoritative.
    let authRound: Round;
    try {
      authRound = await readJson(getPrivateBlobClient(path), RoundSchema, path);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        throw new HttpError(404, "NOT_FOUND", "Round not found");
      }
      throw new HttpError(500, "INTERNAL");
    }

    const authTeam = authRound.teams.find((t) => t.id === teamId);
    if (!authTeam) {
      throw new HttpError(404, "NOT_FOUND", "Team not found");
    }

    if (!caller.clubId || caller.clubId !== authTeam.club.id) {
      throw new HttpError(403, "FORBIDDEN", "Not your team");
    }
  }

  await mutationRateLimit(req, caller, "setTeamCaptain", "standard");

  const body = (await req.json()) as { pilotId?: string | null };
  // undefined body.pilotId means caller omitted the field → treat as null
  const newCaptainId: string | null = body.pilotId ?? null;

  const updatedTeam = await withPrivateLeaseRetry(path, async (leaseId) => {
    let round: Round;
    try {
      round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        throw new HttpError(404, "NOT_FOUND", "Round not found");
      }
      throw new HttpError(500, "INTERNAL");
    }

    const teamIdx = round.teams.findIndex((t) => t.id === teamId);
    if (teamIdx === -1) {
      throw new HttpError(404, "NOT_FOUND", "Team not found");
    }
    const team = round.teams[teamIdx];

    // RoundsCoord must belong to the target team's club
    if (isCoord && !isAdmin) {
      if (!caller.clubId || caller.clubId !== team.club.id) {
        throw new HttpError(403, "FORBIDDEN", "Not your team");
      }
    }

    if (isRosterFrozen(round.status)) {
      throw new HttpError(
        409,
        "ROUND_LOCKED",
        `Cannot change the team captain while ${rosterFrozenReason(round.status)}`,
      );
    }

    // Validate pilotId is a filled member of this team (when non-null)
    if (newCaptainId !== null) {
      const inTeam = team.pilots.some(
        (s) => s.status === "Filled" && s.pilotId === newCaptainId,
      );
      if (!inTeam) {
        throw new HttpError(
          400,
          "PILOT_NOT_IN_TEAM",
          "Pilot is not a filled member of this team",
        );
      }
    }

    team.captainPilotId = newCaptainId;
    round.teams[teamIdx] = team;

    await writePrivateJson(path, RoundSchema, round, leaseId);
    return team;
  });

  return { status: 200, jsonBody: updatedTeam };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("setTeamCaptain", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/captain",
  handler: withErrorHandler(setTeamCaptain),
});
