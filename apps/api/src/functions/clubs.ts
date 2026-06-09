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
    throw err;
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

  let body: { name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON" } };
  }

  if (!body.name?.trim()) {
    return { status: 400, jsonBody: { error: "name is required" } };
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

  const id = req.params["id"];
  if (!id) return { status: 400, jsonBody: { error: "Missing club id" } };

  let existing: Club;
  try {
    existing = await readBlob<Club>(getPrivateBlobClient(`clubs/${id}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 404, jsonBody: { error: "Club not found" } };
    }
    throw err;
  }

  let body: Partial<Club>;
  try {
    body = (await req.json()) as Partial<Club>;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON" } };
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
  handler: getClubs,
});

app.http("createClub", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "clubs",
  handler: createClub,
});

app.http("updateClub", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "clubs/{id}",
  handler: updateClub,
});
