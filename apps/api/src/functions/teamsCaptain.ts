/**
 * PUT /api/rounds/{id}/teams/{teamId}/captain
 *
 * Manual captain override — Admin or (RoundsCoord scoped to the round's
 * organising club). Blocked once the round is Locked or Complete.
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
import { RoundSchema } from "@bccweb/schemas";
import {
  getPrivateBlobClient,
  withPrivateLease,
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
    // Authorization-only pre-read; the leased read below remains authoritative, so club-reassignment races fail closed at worst.
    let authRound: Round;
    try {
      authRound = await readJson(getPrivateBlobClient(path), RoundSchema, path);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        throw new HttpError(404, "NOT_FOUND", "Round not found");
      }
      throw new HttpError(500, "INTERNAL");
    }

    if (
      !caller.clubId ||
      !authRound.organisingClub?.id ||
      caller.clubId !== authRound.organisingClub.id
    ) {
      throw new HttpError(403, "FORBIDDEN", "Not your round");
    }
  }

  await mutationRateLimit(req, caller, "setTeamCaptain", "standard");

  const body = (await req.json()) as { pilotId?: string | null };
  // undefined body.pilotId means caller omitted the field → treat as null
  const newCaptainId: string | null = body.pilotId ?? null;

  const updatedTeam = await withPrivateLease(path, async (leaseId) => {
    let round: Round;
    try {
      round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        throw new HttpError(404, "NOT_FOUND", "Round not found");
      }
      throw new HttpError(500, "INTERNAL");
    }

    // RoundsCoord must belong to the round's organising club
    if (isCoord && !isAdmin) {
      if (
        !caller.clubId ||
        !round.organisingClub?.id ||
        caller.clubId !== round.organisingClub.id
      ) {
        throw new HttpError(403, "FORBIDDEN", "Not your round");
      }
    }

    if (round.status === "Locked" || round.status === "Complete") {
      throw new HttpError(
        409,
        "ROUND_LOCKED",
        "Cannot change the team captain after the round is locked",
      );
    }

    const teamIdx = round.teams.findIndex((t) => t.id === teamId);
    if (teamIdx === -1) {
      throw new HttpError(404, "NOT_FOUND", "Team not found");
    }
    const team = round.teams[teamIdx];

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
