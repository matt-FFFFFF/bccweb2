/**
 * Pilot endpoints — Phase 2 + Phase 5
 *
 * GET  /api/pilots      — pilot index (auth required; Admin=all, RoundsCoord=own club, Pilot=403)
 * GET  /api/pilots/{id} — pilot detail (auth required; Admin=any, RoundsCoord=own club, Pilot=own only)
 * POST /api/pilots      — create pilot (Admin) — Phase 5
 * PUT  /api/pilots/{id} — update pilot profile (Admin or own Pilot) — Phase 5
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "crypto";
import type {
  Pilot,
  PilotSummary,
  WingClass,
  CoachType,
  PilotRatingValue,
  ManufacturerRef,
  ClubRef,
} from "@bccweb/types";
import {
  getBlobClient,
  getBlockBlobClient,
  getPrivateBlobClient,
  readBlob,
  writePrivateBlob,
  withLease,
} from "../lib/blob.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";

// ─── GET /api/pilots ──────────────────────────────────────────────────────────

async function getPilots(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const isAdmin = caller.roles.includes("Admin");
  const isCoord = caller.roles.includes("RoundsCoord");

  // Pilots (and users with no special role) cannot list all pilots
  if (!isAdmin && !isCoord) return forbiddenResponse();

  try {
    let pilots = await readBlob<PilotSummary[]>(getBlobClient("pilots.json"));
    pilots.sort((a, b) => a.name.localeCompare(b.name));

    // RoundsCoord sees only pilots from their own club
    if (isCoord && !isAdmin) {
      pilots = pilots.filter((p) => p.clubId === caller.clubId);
    }

    return { status: 200, jsonBody: pilots };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 200, jsonBody: [] };
    }
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── GET /api/pilots/{id} ─────────────────────────────────────────────────────

async function getPilotById(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_PILOT_ID", "Missing pilot id");

  const isAdmin = caller.roles.includes("Admin");
  const isCoord = caller.roles.includes("RoundsCoord");
  const isSelf = caller.pilotId === id;

  // Pilot-role users can only view their own profile
  if (!isAdmin && !isCoord && !isSelf) return forbiddenResponse();

  try {
    const pilot = await readBlob<Pilot>(getPrivateBlobClient(`pilots/${id}.json`));

    // RoundsCoord can only view pilots in their own club
    if (isCoord && !isAdmin && pilot.currentClub?.id !== caller.clubId) {
      return forbiddenResponse();
    }

    return { status: 200, jsonBody: pilot };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Pilot not found");
    }
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── POST /api/pilots ─────────────────────────────────────────────────────────

interface CreatePilotBody {
  firstName: string;
  lastName: string;
  phoneNumber?: string;
  email?: string;        // stored in index for auto-linking
  bhpaNumber?: number;
  coachType?: CoachType;
  pilotRating?: PilotRatingValue;
  wingClass?: WingClass;
  wingManufacturer?: ManufacturerRef;
  wingModel?: string;
  wingColours?: string;
  helmetColour?: string;
  harnessType?: string;
  harnessColour?: string;
  emergencyContactName?: string;
  emergencyPhoneNumber?: string;
  medicalInfo?: string;
  pureTrackId?: number;
  pureTrackLink?: string;
  currentClub?: ClubRef;
}

async function createPilot(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();

  let body: CreatePilotBody;
  try {
    body = (await req.json()) as CreatePilotBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  if (!body.firstName?.trim() || !body.lastName?.trim()) {
    throw new HttpError(400, "INVALID_BODY", "firstName and lastName are required");
  }

  const id = randomUUID();
  const fullName = `${body.firstName.trim()} ${body.lastName.trim()}`;

  const pilot: Pilot = {
    id,
    bhpaNumber: body.bhpaNumber,
    coachType: body.coachType ?? "None",
    pilotRating: body.pilotRating ?? "Pilot",
    pureTrackId: body.pureTrackId,
    pureTrackLink: body.pureTrackLink,
    helmetColour: body.helmetColour,
    harnessType: body.harnessType,
    harnessColour: body.harnessColour,
    emergencyContactName: body.emergencyContactName,
    emergencyPhoneNumber: body.emergencyPhoneNumber,
    medicalInfo: body.medicalInfo,
    wingClass: body.wingClass,
    wingManufacturer: body.wingManufacturer,
    wingModel: body.wingModel,
    wingColours: body.wingColours,
    person: {
      id: randomUUID(),
      firstName: body.firstName.trim(),
      lastName: body.lastName.trim(),
      fullName,
      phoneNumber: body.phoneNumber,
    },
    currentClub: body.currentClub,
    seasonClubs: [],
    userId: null,
  };

  await writePrivateBlob(`pilots/${id}.json`, pilot);
  await upsertPilotInIndex(pilot, body.email);

  return { status: 201, jsonBody: pilot };
}

// ─── PUT /api/pilots/{id} ─────────────────────────────────────────────────────

interface UpdatePilotBody {
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  helmetColour?: string;
  harnessType?: string;
  harnessColour?: string;
  emergencyContactName?: string;
  emergencyPhoneNumber?: string;
  medicalInfo?: string;
  wingClass?: WingClass;
  wingManufacturer?: ManufacturerRef;
  wingModel?: string;
  wingColours?: string;
  currentClub?: ClubRef;
  // Admin-only fields
  bhpaNumber?: number;
  coachType?: CoachType;
  pilotRating?: PilotRatingValue;
  pureTrackId?: number;
  pureTrackLink?: string;
  email?: string;
}

async function updatePilot(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_PILOT_ID", "Missing pilot id");

  const isAdmin = caller.roles.includes("Admin");
  const isSelf = caller.pilotId === id;

  if (!isAdmin && !isSelf) return forbiddenResponse();

  let existing: Pilot;
  try {
    existing = await readBlob<Pilot>(getPrivateBlobClient(`pilots/${id}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Pilot not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  let body: UpdatePilotBody;
  try {
    body = (await req.json()) as UpdatePilotBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  // Build updated pilot — common fields (both Admin and self)
  const firstName = body.firstName?.trim() ?? existing.person.firstName;
  const lastName = body.lastName?.trim() ?? existing.person.lastName;

  const updated: Pilot = {
    ...existing,
    // Self-service fields
    helmetColour: body.helmetColour ?? existing.helmetColour,
    harnessType: body.harnessType ?? existing.harnessType,
    harnessColour: body.harnessColour ?? existing.harnessColour,
    emergencyContactName:
      body.emergencyContactName ?? existing.emergencyContactName,
    emergencyPhoneNumber:
      body.emergencyPhoneNumber ?? existing.emergencyPhoneNumber,
    medicalInfo: body.medicalInfo ?? existing.medicalInfo,
    wingClass: body.wingClass ?? existing.wingClass,
    wingManufacturer: body.wingManufacturer ?? existing.wingManufacturer,
    wingModel: body.wingModel ?? existing.wingModel,
    wingColours: body.wingColours ?? existing.wingColours,
    currentClub: body.currentClub ?? existing.currentClub,
    person: {
      ...existing.person,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      phoneNumber: body.phoneNumber ?? existing.person.phoneNumber,
    },
    // Admin-only fields
    ...(isAdmin && {
      bhpaNumber: body.bhpaNumber ?? existing.bhpaNumber,
      coachType: body.coachType ?? existing.coachType,
      pilotRating: body.pilotRating ?? existing.pilotRating,
      pureTrackId: body.pureTrackId ?? existing.pureTrackId,
      pureTrackLink: body.pureTrackLink ?? existing.pureTrackLink,
    }),
  };

  await writePrivateBlob(`pilots/${id}.json`, updated);
  await upsertPilotInIndex(updated, isAdmin ? body.email : undefined);

  return { status: 200, jsonBody: updated };
}

// ─── Index helper ─────────────────────────────────────────────────────────────

async function upsertPilotInIndex(
  pilot: Pilot,
  email?: string
): Promise<void> {
  await ensurePilotsIndexBlob();

  await withLeaseRetry("pilots.json", async (leaseId) => {
    let index: PilotSummary[] = [];
    try {
      index = await readBlob<PilotSummary[]>(getBlobClient("pilots.json"));
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }

    const existing = index.find((p) => p.id === pilot.id);
    const entry: PilotSummary = {
      ...(existing ?? {}),
      id: pilot.id,
      legacyId: pilot.legacyId,
      bhpaNumber: pilot.bhpaNumber,
      name: pilot.person.fullName,
      email: email ?? existing?.email,
      clubId: pilot.currentClub?.id,
      rating: pilot.pilotRating,
      userId: pilot.userId,
    };

    const idx = index.findIndex((p) => p.id === pilot.id);
    if (idx >= 0) {
      index[idx] = entry;
    } else {
      index.push(entry);
    }

    index.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const content = JSON.stringify(index, null, 2);
    await getBlockBlobClient("pilots.json").uploadData(Buffer.from(content), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { leaseId },
    });
  });
}

async function withLeaseRetry(
  path: string,
  fn: (leaseId: string) => Promise<void>
): Promise<void> {
  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await withLease(path, fn);
      return;
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode !== 409 && statusCode !== 412) throw err;
      if (attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

async function ensurePilotsIndexBlob(): Promise<void> {
  const client = getBlockBlobClient("pilots.json");
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await client.uploadData(Buffer.from("[]"), {
        blobHTTPHeaders: { blobContentType: "application/json" },
        conditions: { ifNoneMatch: "*" },
      });
      return;
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 409) return;
      if (statusCode !== 412 || attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("getPilots", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "pilots",
  handler: withErrorHandler(getPilots),
});

app.http("getPilotById", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "pilots/{id}",
  handler: withErrorHandler(getPilotById),
});

app.http("createPilot", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "pilots",
  handler: withErrorHandler(createPilot),
});

app.http("updatePilot", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "pilots/{id}",
  handler: withErrorHandler(updatePilot),
});
