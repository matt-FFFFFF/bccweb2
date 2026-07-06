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
  PilotClubMembership,
  WingClass,
  CoachType,
  PilotRatingValue,
  ManufacturerRef,
  ClubRef,
} from "@bccweb/types";
import {
  PilotSchema,
  PilotSummarySchema,
} from "@bccweb/schemas";
import * as z from "zod/v4";
import {
  getBlobClient,
  getPrivateBlobClient,
  withLeaseRetry,
  withPrivateLease,
  ensureJsonIndexBlob,
  writeBlob,
} from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import {
  EmailIndexConflictError,
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
  releasePilotEmailClaim,
  updatePilotEmailIndex,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import { resolveWingManufacturer } from "../lib/wingManufacturer.js";
import { getActiveSeasonYear } from "../lib/season.js";
import { hasFlownInSeason } from "../lib/pilotFlown.js";
import { upsertPilotClubMap } from "../lib/pilotClubMap.js";
import { withSeasonClub } from "../lib/pilotClub.js";
import { getTelemetryClient } from "../lib/telemetry.js";

const PilotsIndexSchema = z.array(PilotSummarySchema);

// PilotClubMembership has no dedicated schema in @bccweb/schemas; the API
// only reads (never writes) this blob here. Permissive array passthrough so
// observe-mode does not strip future legacy migration fields.
const PilotClubHistorySchema = z.array(z.unknown()).transform(
  (rows) => rows as PilotClubMembership[],
);

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
    let pilots = await readJson(
      getBlobClient("pilots.json"),
      PilotsIndexSchema,
      "pilots.json",
    );
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
    const pilot = await readJson(
      getPrivateBlobClient(`pilots/${id}.json`),
      PilotSchema,
      `pilots/${id}.json`,
    );

    // Coord club-scoping applies to OTHER pilots only — a coord can always
    // view their own profile (isSelf), even after changing their personal club.
    if (isCoord && !isAdmin && !isSelf && pilot.currentClub?.id !== caller.clubId) {
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
  await mutationRateLimit(req, caller, "createPilot", "standard");

  let body: CreatePilotBody;
  try {
    body = (await req.json()) as CreatePilotBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  if (!body.firstName?.trim() || !body.lastName?.trim()) {
    throw new HttpError(400, "INVALID_BODY", "firstName and lastName are required");
  }

  // Canonicalise the wing manufacturer; an unknown id aborts before any write.
  const wingManufacturer = await resolveWingManufacturer(
    undefined,
    body.wingManufacturer,
  );

  const id = randomUUID();
  const fullName = `${body.firstName.trim()} ${body.lastName.trim()}`;

  const pilot: Pilot = {
    id,
    legacyId: null,
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
    wingManufacturer,
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

  // Claim the unique email FIRST so a conflict aborts with zero side effects (issue #126).
  if (body.email) {
    try {
      await updatePilotEmailIndex(body.email, id);
    } catch (err: unknown) {
      if (err instanceof EmailIndexConflictError) {
        throw new HttpError(409, "PILOT_EMAIL_TAKEN", "Email already belongs to another pilot");
      }
      throw err;
    }
  }

  // Durable writes after the claim; roll back the reservation + blob on any failure (issue #126).
  try {
    await writePrivateJson(`pilots/${id}.json`, PilotSchema, pilot);
    await upsertPilotInIndex(pilot);
  } catch (err: unknown) {
    if (body.email) await releasePilotEmailClaim(body.email, id).catch(() => {});
    await getPrivateBlobClient(`pilots/${id}.json`).deleteIfExists().catch(() => {});
    throw err;
  }

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
  bhpaNumber?: number;
  coachType?: CoachType;
  pilotRating?: PilotRatingValue;
  pureTrackId?: number;
  pureTrackLink?: string;
  // email is honoured only for Admins (feeds the pilot auto-link index)
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
  await mutationRateLimit(req, caller, "updatePilot", "standard");

  let existing: Pilot;
  try {
    existing = await readJson(
      getPrivateBlobClient(`pilots/${id}.json`),
      PilotSchema,
      `pilots/${id}.json`,
    );
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

  // Shared field-merge for both the leased (club-change) and unleased paths, so
  // the merge lives once. `base` is whichever pilot snapshot the caller read.
  const buildUpdatedPilot = async (base: Pilot): Promise<Pilot> => {
    const wingManufacturer = await resolveWingManufacturer(
      base.wingManufacturer,
      body.wingManufacturer,
    );
    const firstName = body.firstName?.trim() ?? base.person.firstName;
    const lastName = body.lastName?.trim() ?? base.person.lastName;
    return {
      ...base,
      // Self-service fields
      helmetColour: body.helmetColour ?? base.helmetColour,
      harnessType: body.harnessType ?? base.harnessType,
      harnessColour: body.harnessColour ?? base.harnessColour,
      emergencyContactName:
        body.emergencyContactName ?? base.emergencyContactName,
      emergencyPhoneNumber:
        body.emergencyPhoneNumber ?? base.emergencyPhoneNumber,
      medicalInfo: body.medicalInfo ?? base.medicalInfo,
      wingClass: body.wingClass ?? base.wingClass,
      wingManufacturer,
      wingModel: body.wingModel ?? base.wingModel,
      wingColours: body.wingColours ?? base.wingColours,
      bhpaNumber: body.bhpaNumber ?? base.bhpaNumber,
      coachType: body.coachType ?? base.coachType,
      pilotRating: body.pilotRating ?? base.pilotRating,
      pureTrackId: body.pureTrackId ?? base.pureTrackId,
      pureTrackLink: body.pureTrackLink ?? base.pureTrackLink,
      currentClub: body.currentClub ?? base.currentClub,
      person: {
        ...base.person,
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`,
        phoneNumber: body.phoneNumber ?? base.person.phoneNumber,
      },
      profileUpdatedAt: new Date().toISOString(),
    };
  };

  // Claim the (admin-supplied) email FIRST so a conflict aborts before any write
  // (issue #126). This mutates the email-index blob, NOT the pilot blob, so it
  // stays OUTSIDE the pilot lease. Re-claiming the pilot's own email is a no-op.
  let releaseEmailOnFailure: string | undefined;
  if (isAdmin && body.email) {
    try {
      const previousOwner = await updatePilotEmailIndex(body.email, id);
      // Only our brand-new claim is safe to roll back; a re-claim of the pilot's own
      // existing email must NOT be released (issue #126 review).
      if (previousOwner === undefined) releaseEmailOnFailure = body.email;
    } catch (err: unknown) {
      if (err instanceof EmailIndexConflictError) {
        throw new HttpError(409, "PILOT_EMAIL_TAKEN", "Email already belongs to another pilot");
      }
      throw err;
    }
  }

  let updated: Pilot;
  // Set only when the club actually changed; carries the post-lease map sync args.
  let clubChange: { year: number; clubId: string } | undefined;
  try {
    if (body.currentClub) {
      const targetClub = body.currentClub;
      // issue #101: the flown-lock is a cheap PUBLIC read taken BEFORE the lease;
      // admins are never locked. The actual club-change decision is re-made against
      // a FRESH read INSIDE the lease so we never act on stale pre-lease state.
      const activeYear = await getActiveSeasonYear();
      const flownLock = !isAdmin && (await hasFlownInSeason(id, activeYear));

      // Serialise the read-modify-write under the pilot lease so the seasonClubs
      // mutation cannot lose a concurrent update (mirrors assignPilotSeasonClub /
      // ensureSeasonClubRecorded, which also mutate seasonClubs under this lease).
      const result = await withPrivateLease(
        `pilots/${id}.json`,
        async (leaseId) => {
          const base = await readJson(
            getPrivateBlobClient(`pilots/${id}.json`),
            PilotSchema,
            `pilots/${id}.json`,
          );
          const clubChanging = base.currentClub?.id !== targetClub.id;
          if (clubChanging && flownLock) {
            throw new HttpError(
              409,
              "CLUB_LOCKED",
              `Your club is locked for the ${activeYear} season because you have flown a scored round. Contact an admin to change it.`,
            );
          }
          // issue #101: self-selected club is intentionally UNGATED — no
          // CLUB_NOT_REGISTERED_FOR_SEASON check, unlike assignPilotSeasonClub.
          const next = await buildUpdatedPilot(base);
          if (clubChanging) {
            next.currentClub = targetClub;
            next.seasonClubs = withSeasonClub(base.seasonClubs, {
              seasonYear: activeYear,
              clubId: targetClub.id,
              clubName: targetClub.name,
            });
          }
          await writePrivateJson(`pilots/${id}.json`, PilotSchema, next, leaseId);
          await upsertPilotInIndex(next, activeYear);
          return { next, clubChanging };
        },
      );
      updated = result.next;
      if (result.clubChanging) {
        clubChange = { year: activeYear, clubId: targetClub.id };
      }
    } else {
      // No club change → no seasonClubs mutation → no shared-array race, so keep
      // the original unleased read/build/write path (byte-identical to before).
      updated = await buildUpdatedPilot(existing);
      await writePrivateJson(`pilots/${id}.json`, PilotSchema, updated);
      await upsertPilotInIndex(updated);
    }
  } catch (err: unknown) {
    if (releaseEmailOnFailure) {
      await releasePilotEmailClaim(releaseEmailOnFailure, id).catch(() => {});
    }
    throw err;
  }

  // issue #101: keep the denormalised seasons/{year}/pilot-club-map.json in sync,
  // best-effort/idempotent. A failure is non-fatal — the pilot blob + pilots.json
  // are authoritative and the map reconciles on the next write. Write ORDER:
  // pilot (leased) → upsertPilotInIndex → upsertPilotClubMap.
  if (clubChange) {
    await upsertPilotClubMap(clubChange.year, id, clubChange.clubId).catch(() => {
      getTelemetryClient()?.trackTrace({
        message: "pilot.clubMapSyncFailed",
        properties: { pilotId: id },
      });
    });
  }

  return { status: 200, jsonBody: updated };
}

// ─── Index helper ─────────────────────────────────────────────────────────────

async function upsertPilotInIndex(pilot: Pilot, activeYear?: number): Promise<void> {
  // Public index shows only VERIFIED active-season club membership, never the
  // self-declared currentClub (a pilot can set that to any club). Stops a pilot
  // poisoning the anonymously-readable index with an unaffiliated club.
  // Callers mid-mutation pass the already-resolved year to skip a second
  // seasons.json read and close a season-flip window between the two reads.
  const year = activeYear ?? (await getActiveSeasonYear());
  const verifiedClubId = pilot.seasonClubs.find(
    (sc) => sc.seasonYear === year,
  )?.clubId;

  await ensureJsonIndexBlob("pilots.json", "[]");

  await withLeaseRetry("pilots.json", async (leaseId) => {
    let index: PilotSummary[] = [];
    try {
      index = await readJson(
        getBlobClient("pilots.json"),
        PilotsIndexSchema,
        "pilots.json",
      );
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }

    const entry: PilotSummary = {
      id: pilot.id,
      legacyId: pilot.legacyId,
      name: pilot.person.fullName,
      clubId: verifiedClubId,
      rating: pilot.pilotRating,
    };

    const idx = index.findIndex((p) => p.id === pilot.id);
    if (idx >= 0) {
      index[idx] = entry;
    } else {
      index.push(entry);
    }

    index.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    await writeBlob("pilots.json", index, leaseId);
  });

}

// ─── GET /api/pilots/{id}/club-history ───────────────────────────────────────

async function getPilotClubHistory(
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

  try {
    const history = await readJson(
      getPrivateBlobClient(`pilots/${id}/club-history.json`),
      PilotClubHistorySchema,
      `pilots/${id}/club-history.json`,
    );
    return { status: 200, jsonBody: history };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "No club history found for this pilot");
    }
    throw new HttpError(500, "INTERNAL");
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

app.http("getPilotClubHistory", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "pilots/{id}/club-history",
  handler: withErrorHandler(getPilotClubHistory),
});
