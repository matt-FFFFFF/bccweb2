/**
 * Self-service pilot record creation for the signed-in user.
 *
 * POST /api/me/pilot — caller must have user.pilotId === null. Creates a new
 * pilot blob, links it to the user (sets pilotId, clubId, adds "Pilot" role),
 * registers in pilots.json + pilot-email-index. Returns 409 if already linked.
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "crypto";
import type {
  ClubRef,
  ManufacturerRef,
  Pilot,
  PilotRatingValue,
  PilotSummary,
  User,
  WingClass,
} from "@bccweb/types";
import {
  PilotSchema,
  PilotSummarySchema,
  UserSchema,
} from "@bccweb/schemas";
import * as z from "zod/v4";
import {
  ensureJsonIndexBlob,
  getBlobClient,
  getBlockBlobClient,
  getPrivateBlobClient,
  withLeaseRetry,
} from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import {
  EmailIndexConflictError,
  getCallerIdentity,
  releasePilotEmailClaim,
  unauthorizedResponse,
  updatePilotEmailIndex,
} from "../lib/auth.js";
import type { AuthCredential } from "../lib/authHelpers.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { resolveWingManufacturer } from "../lib/wingManufacturer.js";

const PilotsIndexSchema = z.array(PilotSummarySchema);

// AuthCredential lives in apps/api/src/lib/authHelpers.ts and has no shared
// Wave 5 schema; this read is verification-gated so the failure mode (treat
// as unverified) is safe. Inline schema mirrors the AuthCredential interface
// so observe-mode never strips a real field.
const AuthCredentialSchema = z
  .object({
    passwordHash: z.string().min(1),
    emailVerified: z.boolean(),
    createdAt: z.string().min(1),
  })
  .strip();

AuthCredentialSchema satisfies z.ZodType<AuthCredential>;

interface CreateMyPilotBody {
  firstName: string;
  lastName: string;
  phoneNumber?: string;
  bhpaNumber?: number;
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
  currentClub?: ClubRef;
}

async function createMyPilot(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  // Defense in depth: re-check emailVerified so stale/leaked tokens issued
  // before verification can never create a pilot record.
  let cred: AuthCredential | null = null;
  try {
    cred = await readJson(
      getPrivateBlobClient(`auth/${caller.userId}.json`),
      AuthCredentialSchema,
      `auth/${caller.userId}.json`,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
  if (!cred?.emailVerified) {
    throw new HttpError(
      403,
      "EMAIL_NOT_VERIFIED",
      "Verify your email address before creating a pilot profile"
    );
  }

  if (caller.pilotId) {
    throw new HttpError(
      409,
      "ALREADY_LINKED",
      "User is already linked to a pilot record"
    );
  }

  let body: CreateMyPilotBody;
  try {
    body = (await req.json()) as CreateMyPilotBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  const firstName = body.firstName?.trim();
  const lastName = body.lastName?.trim();
  if (!firstName || !lastName) {
    throw new HttpError(
      400,
      "INVALID_BODY",
      "firstName and lastName are required"
    );
  }

  // Canonicalise the wing manufacturer; an unknown id aborts before any write.
  const wingManufacturer = await resolveWingManufacturer(
    undefined,
    body.wingManufacturer,
  );

  const id = randomUUID();
  const now = new Date().toISOString();
  const pilot: Pilot = {
    id,
    legacyId: null,
    bhpaNumber: body.bhpaNumber,
    coachType: "None",
    pilotRating: body.pilotRating ?? "Pilot",
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
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      phoneNumber: body.phoneNumber,
    },
    currentClub: body.currentClub,
    seasonClubs: [],
    userId: caller.userId,
    createdAt: now,
    updatedAt: now,
    updatedBy: caller.userId,
    profileUpdatedAt: now,
  };

  // Claim the unique email FIRST so a conflict aborts with zero side effects (issue #126).
  try {
    await updatePilotEmailIndex(caller.email, id);
  } catch (err: unknown) {
    if (err instanceof EmailIndexConflictError) {
      throw new HttpError(
        409,
        "PILOT_EMAIL_TAKEN",
        "Email already belongs to another pilot"
      );
    }
    throw err;
  }

  // Durable writes after the claim, with the user link LAST so any failure leaves
  // user.pilotId null (never half-linked to a rolled-back pilot). On failure, undo
  // the public index entry, delete the private blob, and release the reservation so a
  // retry starts clean (issue #126).
  try {
    await writePrivateJson(`pilots/${id}.json`, PilotSchema, pilot);
    await upsertPilotInIndex(pilot);
    await linkUserToPilot(caller.userId, id, body.currentClub?.id ?? null);
  } catch (err: unknown) {
    await releasePilotEmailClaim(caller.email, id).catch(() => {});
    await removePilotFromIndex(id).catch(() => {});
    await getPrivateBlobClient(`pilots/${id}.json`).deleteIfExists().catch(() => {});
    throw err;
  }

  return { status: 201, jsonBody: pilot };
}

async function linkUserToPilot(
  userId: string,
  pilotId: string,
  clubId: string | null
): Promise<void> {
  const userPath = `users/${userId}.json`;
  const user: User = await readJson(
    getPrivateBlobClient(userPath),
    UserSchema,
    userPath,
  );
  const updated: User = {
    ...user,
    pilotId,
    clubId: clubId ?? user.clubId,
    roles: user.roles.includes("Pilot") ? user.roles : [...user.roles, "Pilot"],
  };
  await writePrivateJson(userPath, UserSchema, updated);
}

async function upsertPilotInIndex(pilot: Pilot): Promise<void> {
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
      // Verified-membership only (Security: E). A self-created pilot has no
      // season-club yet, so no public club affiliation until one is assigned;
      // never expose the self-declared currentClub in the anonymous index.
      clubId: undefined,
      rating: pilot.pilotRating,
    };
    const idx = index.findIndex((p) => p.id === pilot.id);
    if (idx >= 0) {
      index[idx] = entry;
    } else {
      index.push(entry);
    }
    index.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
    // Lease-coupled write retains the raw BlockBlobClient.uploadData path —
    // writeJson/writeBlob do not currently expose ifMatch/leaseId conditions
    // for this index slot. Schema healing applies through the readJson above.
    const content = JSON.stringify(index, null, 2);
    await getBlockBlobClient("pilots.json").uploadData(Buffer.from(content), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { leaseId },
    });
  });
}

async function removePilotFromIndex(pilotId: string): Promise<void> {
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
      return;
    }
    const next = index.filter((p) => p.id !== pilotId);
    if (next.length === index.length) return;
    const content = JSON.stringify(next, null, 2);
    await getBlockBlobClient("pilots.json").uploadData(Buffer.from(content), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { leaseId },
    });
  });
}

app.http("createMyPilot", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "me/pilot",
  handler: withErrorHandler(createMyPilot),
});
