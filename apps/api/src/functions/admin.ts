/**
 * Admin endpoints — Phase 3 + Phase 5
 *
 * POST /api/admin/rounds/{id}/recompute — recompute all derived blobs for a round's season
 * GET  /api/admin/config                — get config document
 * PUT  /api/admin/config                — update config document
 * GET  /api/admin/users                 — list all users + roles (Phase 5)
 * PUT  /api/admin/users/{userId}/roles  — set user roles (Phase 5)
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { Config, Round, User, UserRole } from "@bccweb/types";
import { getPrivateBlobClient, readBlob, writePrivateBlob } from "../lib/blob.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { recomputeSeason, updateRoundsIndex } from "../lib/recompute.js";

// ─── Auth helper ──────────────────────────────────────────────────────────────

function isAdmin(roles: string[]): boolean {
  return roles.includes("Admin");
}

// ─── POST /api/admin/rounds/{id}/recompute ────────────────────────────────────
/**
 * Recompute all derived blobs for the season containing round {id}.
 * Also refreshes the round's entry in rounds.json.
 * Use this to recover from partial failures during completeRound.
 */
async function recomputeRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  let round: Round;
  try {
    round = await readBlob<Round>(getPrivateBlobClient(`rounds/${id}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  // Refresh the round's index entry
  await updateRoundsIndex(round);

  // Recompute season derived blobs
  try {
    await recomputeSeason(round.season.year);
  } catch (err: unknown) {
    throw new HttpError(500, "RECOMPUTE_FAILED");
  }

  return {
    status: 200,
    jsonBody: { message: `Recomputed season ${round.season.year}` },
  };
}

// ─── GET /api/admin/config ────────────────────────────────────────────────────

async function getConfig(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();

  try {
    const config = await readBlob<Config>(getPrivateBlobClient("config.json"));
    return { status: 200, jsonBody: config };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      // Return sensible defaults when config.json hasn't been written yet
      const defaults: Config = {
        maxTeamsInClub: 2,
        maxPilotsInTeam: 12,
        maxScoringPilotsInTeam: 6,
        flightDateValidationEnabled: true,
        wingFactors: {
          "EN A": 1.0,
          "EN B": 0.9,
          "EN C": 0.8,
          "EN C 2-liner": 0.7,
          "EN D": 0.6,
          "EN D 2-liner": 0.5,
        },
      };
      return { status: 200, jsonBody: defaults };
    }
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── PUT /api/admin/config ────────────────────────────────────────────────────

async function updateConfig(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();

  const body = (await req.json()) as Partial<Config>;

  // Merge with existing (or start fresh)
  let existing: Config = {
    maxTeamsInClub: 2,
    maxPilotsInTeam: 12,
    maxScoringPilotsInTeam: 6,
    flightDateValidationEnabled: true,
    wingFactors: {
      "EN A": 1.0,
      "EN B": 0.9,
      "EN C": 0.8,
      "EN C 2-liner": 0.7,
      "EN D": 0.6,
      "EN D 2-liner": 0.5,
    },
  };

  try {
    existing = await readBlob<Config>(getPrivateBlobClient("config.json"));
  } catch {
    // start with defaults
  }

  const updated: Config = {
    ...existing,
    ...body,
    // Deep-merge wingFactors
    wingFactors: {
      ...existing.wingFactors,
      ...(body.wingFactors ?? {}),
    },
  };

  await writePrivateBlob("config.json", updated);
  return { status: 200, jsonBody: updated };
}

// ─── GET /api/admin/users ─────────────────────────────────────────────────────

async function listUsers(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();

  let index: Record<string, string> = {};
  try {
    index = await readBlob<Record<string, string>>(
      getPrivateBlobClient("user-index.json")
    );
  } catch {
    return { status: 200, jsonBody: [] };
  }

  const userIds = Object.values(index);
  const users = await Promise.all(
    userIds.map((id) =>
      readBlob<User>(getPrivateBlobClient(`users/${id}.json`)).catch(() => null)
    )
  );

  const valid = users.filter((u): u is User => u !== null);
  valid.sort((a, b) => a.email.localeCompare(b.email));

  return { status: 200, jsonBody: valid };
}

// ─── PUT /api/admin/users/{userId}/roles ─────────────────────────────────────

async function setUserRoles(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();

  const userId = req.params["userId"];
  if (!userId) throw new HttpError(400, "MISSING_USER_ID", "Missing userId");

  let body: { roles?: UserRole[]; pilotId?: string | null; clubId?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  let user: User;
  try {
    user = await readBlob<User>(getPrivateBlobClient(`users/${userId}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "User not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  const updated: User = {
    ...user,
    ...(body.roles !== undefined && { roles: body.roles }),
    ...(body.pilotId !== undefined && { pilotId: body.pilotId }),
    ...(body.clubId !== undefined && { clubId: body.clubId }),
  };

  await writePrivateBlob(`users/${userId}.json`, updated);
  return { status: 200, jsonBody: updated };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("recomputeRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "manage/rounds/{id}/recompute",
  handler: withErrorHandler(recomputeRound),
});

app.http("getConfig", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "manage/config",
  handler: withErrorHandler(getConfig),
});

app.http("updateConfig", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "manage/config",
  handler: withErrorHandler(updateConfig),
});

app.http("listUsers", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "manage/users",
  handler: withErrorHandler(listUsers),
});

app.http("setUserRoles", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "manage/users/{userId}/roles",
  handler: withErrorHandler(setUserRoles),
});
