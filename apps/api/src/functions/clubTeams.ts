/**
 * Club Team endpoints
 *
 * GET    /api/club-teams           — list all club teams (public); filter via ?clubId= &seasonYear=
 * POST   /api/club-teams           — create a club team (Admin or RoundsCoord for own club)
 * PUT    /api/club-teams/{id}      — rename a club team (Admin or RoundsCoord for own club)
 * DELETE /api/club-teams/{id}      — delete a club team (Admin or RoundsCoord for own club)
 *
 * Storage layout:
 *   club-teams/{uuid}.json   — individual ClubTeam document
 *   club-teams.json          — ClubTeamSummary[] index
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "crypto";
import type { Club, ClubTeam, ClubTeamSummary } from "@bccweb/types";
import {
  ClubSchema,
  ClubTeamSchema,
  ClubTeamSummarySchema,
} from "@bccweb/schemas";
import * as z from "zod/v4";
import { getBlobClient, getPrivateBlobClient } from "../lib/blob.js";
import { readJson, writeJson, writePrivateJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";

const ClubTeamsIndexSchema = z.array(ClubTeamSummarySchema);

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function isAdminOrCoord(roles: string[]): boolean {
  return roles.includes("Admin") || roles.includes("RoundsCoord");
}

/** Admin can manage any club's teams; RoundsCoord can only manage their own. */
function canManageClub(
  roles: string[],
  callerClubId: string | null,
  targetClubId: string
): boolean {
  if (roles.includes("Admin")) return true;
  if (roles.includes("RoundsCoord") && callerClubId === targetClubId) return true;
  return false;
}

// ─── GET /api/club-teams ──────────────────────────────────────────────────────

async function getClubTeams(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  let index: ClubTeamSummary[] = [];
  try {
    index = await readJson(
      getBlobClient("club-teams.json"),
      ClubTeamsIndexSchema,
      "club-teams.json",
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 200, jsonBody: [] };
    }
    throw new HttpError(500, "INTERNAL");
  }

  const clubId = req.query.get("clubId");
  const seasonYearParam = req.query.get("seasonYear");
  const seasonYear = seasonYearParam ? parseInt(seasonYearParam, 10) : null;

  let result = index;
  if (clubId) result = result.filter((t) => t.clubId === clubId);
  if (seasonYear && !isNaN(seasonYear)) result = result.filter((t) => t.seasonYear === seasonYear);

  return { status: 200, jsonBody: result };
}

// ─── POST /api/club-teams ─────────────────────────────────────────────────────

async function createClubTeam(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdminOrCoord(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "createClubTeam", "standard");

  let body: { clubId?: string; seasonYear?: number; teamName?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  if (!body.clubId?.trim()) {
    throw new HttpError(400, "INVALID_BODY", "clubId is required");
  }
  if (!body.teamName?.trim()) {
    throw new HttpError(400, "INVALID_BODY", "teamName is required");
  }
  if (!body.seasonYear || isNaN(body.seasonYear)) {
    throw new HttpError(400, "INVALID_BODY", "seasonYear is required");
  }

  if (!canManageClub(caller.roles, caller.clubId, body.clubId)) {
    return forbiddenResponse();
  }

  // Load club to get name
  let clubName: string;
  try {
    const club = await readJson(
      getPrivateBlobClient(`clubs/${body.clubId}.json`),
      ClubSchema,
      `clubs/${body.clubId}.json`,
    );
    clubName = club.name;
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(400, "INVALID_BODY", "Club not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  // Guard: duplicate team name for same club+season
  let existingIndex: ClubTeamSummary[] = [];
  try {
    existingIndex = await readJson(
      getBlobClient("club-teams.json"),
      ClubTeamsIndexSchema,
      "club-teams.json",
    );
  } catch {
    // index may not exist yet
  }

  const duplicate = existingIndex.some(
    (t) =>
      t.clubId === body.clubId &&
      t.seasonYear === body.seasonYear &&
      t.teamName.toLowerCase() === body.teamName!.trim().toLowerCase()
  );
  if (duplicate) {
    return {
      status: 409,
      jsonBody: { error: "A team with that name already exists for this club and season" },
    };
  }

  const id = randomUUID();
  const team: ClubTeam = {
    id,
    clubId: body.clubId,
    clubName,
    seasonYear: body.seasonYear,
    teamName: body.teamName.trim(),
    createdAt: new Date().toISOString(),
  };

  await writePrivateJson(`club-teams/${id}.json`, ClubTeamSchema, team);
  await upsertTeamInIndex(team);

  return { status: 201, jsonBody: team };
}

// ─── PUT /api/club-teams/{id} ─────────────────────────────────────────────────

async function updateClubTeam(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdminOrCoord(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "updateClubTeam", "standard");

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_CLUB_TEAM_ID", "Missing club team id");

  let existing: ClubTeam;
  try {
    existing = await readJson(
      getPrivateBlobClient(`club-teams/${id}.json`),
      ClubTeamSchema,
      `club-teams/${id}.json`,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Club team not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  if (!canManageClub(caller.roles, caller.clubId, existing.clubId)) {
    return forbiddenResponse();
  }

  let body: { teamName?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  if (!body.teamName?.trim()) {
    throw new HttpError(400, "INVALID_BODY", "teamName is required");
  }

  // Guard: duplicate name for same club+season (excluding self)
  let index: ClubTeamSummary[] = [];
  try {
    index = await readJson(
      getBlobClient("club-teams.json"),
      ClubTeamsIndexSchema,
      "club-teams.json",
    );
  } catch {
    // ignore
  }

  const duplicate = index.some(
    (t) =>
      t.id !== id &&
      t.clubId === existing.clubId &&
      t.seasonYear === existing.seasonYear &&
      t.teamName.toLowerCase() === body.teamName!.trim().toLowerCase()
  );
  if (duplicate) {
    return {
      status: 409,
      jsonBody: { error: "A team with that name already exists for this club and season" },
    };
  }

  const updated: ClubTeam = {
    ...existing,
    teamName: body.teamName.trim(),
  };

  await writePrivateJson(`club-teams/${id}.json`, ClubTeamSchema, updated);
  await upsertTeamInIndex(updated);

  return { status: 200, jsonBody: updated };
}

// ─── DELETE /api/club-teams/{id} ──────────────────────────────────────────────

async function deleteClubTeam(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdminOrCoord(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "deleteClubTeam", "standard");

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_CLUB_TEAM_ID", "Missing club team id");

  let existing: ClubTeam;
  try {
    existing = await readJson(
      getPrivateBlobClient(`club-teams/${id}.json`),
      ClubTeamSchema,
      `club-teams/${id}.json`,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Club team not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  if (!canManageClub(caller.roles, caller.clubId, existing.clubId)) {
    return forbiddenResponse();
  }

  // Soft delete: remove from index and delete the blob
  await removeTeamFromIndex(id);
  await getPrivateBlobClient(`club-teams/${id}.json`).delete();

  return { status: 200, jsonBody: { id } };
}

// ─── Index helpers ────────────────────────────────────────────────────────────

async function upsertTeamInIndex(team: ClubTeam): Promise<void> {
  const summary: ClubTeamSummary = {
    id: team.id,
    clubId: team.clubId,
    clubName: team.clubName,
    seasonYear: team.seasonYear,
    teamName: team.teamName,
  };

  let index: ClubTeamSummary[] = [];
  try {
    index = await readJson(
      getBlobClient("club-teams.json"),
      ClubTeamsIndexSchema,
      "club-teams.json",
    );
  } catch {
    // index may not exist yet
  }

  const idx = index.findIndex((t) => t.id === summary.id);
  if (idx >= 0) {
    index[idx] = summary;
  } else {
    index.push(summary);
  }

  // Sort: season desc, club name asc, team name asc
  index.sort((a, b) => {
    if (b.seasonYear !== a.seasonYear) return b.seasonYear - a.seasonYear;
    if (a.clubName !== b.clubName) return a.clubName.localeCompare(b.clubName);
    return a.teamName.localeCompare(b.teamName);
  });

  await writeJson("club-teams.json", ClubTeamsIndexSchema, index);
}

async function removeTeamFromIndex(id: string): Promise<void> {
  let index: ClubTeamSummary[] = [];
  try {
    index = await readJson(
      getBlobClient("club-teams.json"),
      ClubTeamsIndexSchema,
      "club-teams.json",
    );
  } catch {
    return;
  }
  const filtered = index.filter((t) => t.id !== id);
  await writeJson("club-teams.json", ClubTeamsIndexSchema, filtered);
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("getClubTeams", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "club-teams",
  handler: withErrorHandler(getClubTeams),
});

app.http("createClubTeam", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "club-teams",
  handler: withErrorHandler(createClubTeam),
});

app.http("updateClubTeam", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "club-teams/{id}",
  handler: withErrorHandler(updateClubTeam),
});

app.http("deleteClubTeam", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "club-teams/{id}",
  handler: withErrorHandler(deleteClubTeam),
});
