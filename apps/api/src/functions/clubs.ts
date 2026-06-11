/**
 * Club endpoints — Phase 2 + Phase 5
 *
 * GET  /api/clubs      — club list (public)
 * POST /api/clubs      — create club (Admin) — Phase 5
 * PUT  /api/clubs/{id} — update club (Admin) — Phase 5
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "crypto";
import type { Club, ClubSummary } from "@bccweb/types";
import { getBlobClient, getPrivateBlobClient, readBlob, writeBlob, writePrivateBlob } from "../lib/blob.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";

// ─── GET /api/clubs ───────────────────────────────────────────────────────────

async function getClubs(
  _req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const clubs = await readBlob<ClubSummary[]>(getBlobClient("clubs.json"));
    clubs.sort((a, b) => a.name.localeCompare(b.name));
    return { status: 200, jsonBody: clubs };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 200, jsonBody: [] };
    }
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── POST /api/clubs ──────────────────────────────────────────────────────────

async function createClub(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();
  await mutationRateLimit(req, caller, "createClub", "standard");

  let body: { name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  if (!body.name?.trim()) {
    throw new HttpError(400, "INVALID_BODY", "name is required");
  }

  const id = randomUUID();
  const club: Club = {
    id,
    name: body.name.trim(),
    sites: [],
    teams: [],
  };

  await writePrivateBlob(`clubs/${id}.json`, club);
  await upsertClubInIndex({ id, name: club.name });

  return { status: 201, jsonBody: club };
}

// ─── PUT /api/clubs/{id} ──────────────────────────────────────────────────────

async function updateClub(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();
  await mutationRateLimit(req, caller, "updateClub", "standard");

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_CLUB_ID", "Missing club id");

  let existing: Club;
  try {
    existing = await readBlob<Club>(getPrivateBlobClient(`clubs/${id}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Club not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  let body: Partial<Club>;
  try {
    body = (await req.json()) as Partial<Club>;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  const updated: Club = {
    ...existing,
    name: body.name?.trim() ?? existing.name,
    sites: body.sites ?? existing.sites,
    teams: body.teams ?? existing.teams,
    id: existing.id, // immutable
  };

  await writePrivateBlob(`clubs/${id}.json`, updated);
  await upsertClubInIndex({ id, name: updated.name });

  return { status: 200, jsonBody: updated };
}

// ─── Index helper ─────────────────────────────────────────────────────────────

async function upsertClubInIndex(summary: ClubSummary): Promise<void> {
  let index: ClubSummary[] = [];
  try {
    index = await readBlob<ClubSummary[]>(getBlobClient("clubs.json"));
  } catch {
    // index may not exist yet
  }

  const idx = index.findIndex((c) => c.id === summary.id);
  if (idx >= 0) {
    index[idx] = summary;
  } else {
    index.push(summary);
  }

  index.sort((a, b) => a.name.localeCompare(b.name));
  await writeBlob("clubs.json", index);
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("getClubs", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "clubs",
  handler: withErrorHandler(getClubs),
});

app.http("createClub", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "clubs",
  handler: withErrorHandler(createClub),
});

app.http("updateClub", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "clubs/{id}",
  handler: withErrorHandler(updateClub),
});
