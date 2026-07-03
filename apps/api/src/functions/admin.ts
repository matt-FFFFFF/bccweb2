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
import type { Config, Round, User } from "@bccweb/types";
import { AuthCredentialSchema, ConfigSchema, RoundSchema, UserSchema } from "@bccweb/schemas";
import * as z from "zod/v4";
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
import { assertNotLastAdmin, withAccountMutationLock } from "../lib/accountMutation.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import { recomputeSeason, updateRoundsIndex } from "../lib/recompute.js";

// ─── Auth helper ──────────────────────────────────────────────────────────────

function isAdmin(roles: string[]): boolean {
  return roles.includes("Admin");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusCodeOf(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode;
}

/**
 * Convert Azure blob-lease conflict (HTTP 409 LeaseAlreadyPresent) into a
 * 503 surfaced through `withErrorHandler`. Concurrent writers retry-later.
 */
function rethrowLeaseConflict(err: unknown): never {
  const status = statusCodeOf(err);
  if (status === 409) {
    throw new HttpError(503, "LEASE_HELD", "Resource locked; retry shortly");
  }
  if (status === 412) {
    // Mid-flight lease lost or precondition failure.
    throw new HttpError(503, "LEASE_LOST", "Resource lease lost; retry shortly");
  }
  throw err;
}

/**
 * Ensure-create a private blob (no overwrite) using `ifNoneMatch: "*"`.
 * Mirrors the `ensurePilotsIndexBlob` pattern at pilots.ts:374-390 but for
 * `data-private` and routed through writePrivateJson so BLOB_SCHEMA_MODE is
 * honoured.
 */
async function ensurePrivateBlob<T>(
  path: string,
  schema: z.ZodType<T>,
  defaults: T,
): Promise<void> {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await writePrivateJson(path, schema, defaults, undefined, {
        ifNoneMatch: "*",
      });
      return;
    } catch (err: unknown) {
      const status = statusCodeOf(err);
      // 409 = blob already exists; nothing to do.
      if (status === 409) return;
      // 412 = ifNoneMatch failed (also "already exists"); nothing to do.
      if (status === 412) return;
      if (attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
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
  await mutationRateLimit(req, caller, "recomputeRound", "standard");

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  let round: Round;
  try {
    round = await readJson(
      getPrivateBlobClient(`rounds/${id}.json`),
      RoundSchema,
      `rounds/${id}.json`,
    );
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  // Refresh the round's index entry
  await updateRoundsIndex(round);

  // Recompute season derived blobs
  try {
    await recomputeSeason(round.season.year);
  } catch (_err: unknown) {
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
    const config = await readJson(
      getPrivateBlobClient("config.json"),
      ConfigSchema,
      "config.json",
    );
    return { status: 200, jsonBody: config };
  } catch (err: unknown) {
    if (statusCodeOf(err) !== 404) throw err;
  }

  // Virgin store: parse {} → ConfigSchema yields full defaults; persist for
  // next reader. ensure-create (ifNoneMatch:"*") tolerates concurrent virgin
  // creates.
  const defaults = ConfigSchema.parse({});
  await ensurePrivateBlob("config.json", ConfigSchema, defaults);
  return { status: 200, jsonBody: defaults };
}

// ─── PUT /api/admin/config ────────────────────────────────────────────────────

async function updateConfig(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "updateConfig", "standard");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  // Client-input validation: reject obviously bad shapes with 400 (don't
  // route through BlobShapeError → 500, which is reserved for storage shape
  // drift). ConfigSchema is `.strict()` on wingFactors so unknown wing keys
  // are rejected here.
  const parsed = ConfigSchema.partial().safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "INVALID_CONFIG",
      `Invalid config: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  const patch: Partial<Config> = parsed.data;

  let merged: Config = ConfigSchema.parse({});
  try {
    await runConfigRmw(patch, (m) => { merged = m; });
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) {
      // Virgin store: seed defaults so the lease has a blob to attach to,
      // then retry the RMW once. ensure-create tolerates concurrent virgins.
      const defaults = ConfigSchema.parse({});
      await ensurePrivateBlob("config.json", ConfigSchema, defaults);
      try {
        await runConfigRmw(patch, (m) => { merged = m; });
      } catch (retryErr: unknown) {
        rethrowLeaseConflict(retryErr);
      }
    } else {
      rethrowLeaseConflict(err);
    }
  }

  return { status: 200, jsonBody: merged };
}

async function runConfigRmw(
  patch: Partial<Config>,
  onMerged: (merged: Config) => void,
): Promise<void> {
  await withPrivateLease("config.json", async (leaseId) => {
    const existing = await readJson(
      getPrivateBlobClient("config.json"),
      ConfigSchema,
      "config.json",
    );
    const merged: Config = {
      ...existing,
      ...patch,
      wingFactors: {
        ...existing.wingFactors,
        ...(patch.wingFactors ?? {}),
      },
    };
    await writePrivateJson("config.json", ConfigSchema, merged, leaseId);
    onMerged(merged);
  });
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
    index = await readJson(
      getPrivateBlobClient("user-index.json"),
      z.record(z.string(), z.string()),
      "user-index.json",
    );
  } catch {
    return { status: 200, jsonBody: [] };
  }

  const userIds = Object.values(index);
  const users = await Promise.all(
    userIds.map((id) =>
      readJson(
        getPrivateBlobClient(`users/${id}.json`),
        UserSchema,
        `users/${id}.json`,
      ).catch(() => null)
    )
  );

  const valid = users.flatMap((u) => (u === null ? [] : [u]));
  valid.sort((a, b) => a.email.localeCompare(b.email));

  return { status: 200, jsonBody: valid };
}

// ─── PUT /api/admin/users/{userId}/roles ─────────────────────────────────────

// Client-input role validation (inline). UserSchema's `roles` field uses
// preprocess+normalisation for stored-blob healing; this stricter schema
// rejects unknown roles outright on the API edge.
const RolesPayloadSchema = z
  .object({
    roles: z.array(z.enum(["Admin", "RoundsCoord", "Pilot"])).optional(),
    pilotId: z.string().nullable().optional(),
    clubId: z.string().nullable().optional(),
  })
  .strict();

async function setUserRoles(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "setUserRoles", "standard");

  const userId = req.params["userId"];
  if (!userId) throw new HttpError(400, "MISSING_USER_ID", "Missing userId");

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  const parsed = RolesPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "INVALID_ROLES_PAYLOAD",
      `Invalid roles payload: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  const body = parsed.data;

  let updated: User | null = null;
  try {
    await withAccountMutationLock(async () => {
      await withPrivateLease(`users/${userId}.json`, async (leaseId) => {
        let user: User;
        try {
          user = await readJson(
            getPrivateBlobClient(`users/${userId}.json`),
            UserSchema,
            `users/${userId}.json`,
          );
        } catch (err: unknown) {
          if (statusCodeOf(err) === 404) {
            throw new HttpError(404, "NOT_FOUND", "User not found");
          }
          throw err;
        }

        if (
          body.roles !== undefined &&
          user.roles.includes("Admin") &&
          !body.roles.includes("Admin")
        ) {
          await assertNotLastAdmin(userId, body.roles);
        }

        updated = {
          ...user,
          ...(body.roles !== undefined && { roles: body.roles }),
          ...(body.pilotId !== undefined && { pilotId: body.pilotId }),
          ...(body.clubId !== undefined && { clubId: body.clubId }),
        };

        await writePrivateJson(
          `users/${userId}.json`,
          UserSchema,
          updated,
          leaseId,
        );
      });
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    // Lease acquire on a non-existent blob 404s; surface that as NOT_FOUND.
    if (statusCodeOf(err) === 404) {
      throw new HttpError(404, "NOT_FOUND", "User not found");
    }
    rethrowLeaseConflict(err);
  }

  // Unreachable on success: withPrivateLease always populates `updated`.
  if (!updated) throw new HttpError(500, "INTERNAL");
  return { status: 200, jsonBody: updated };
}

// ─── POST /api/manage/users/{userId}/verify-email ────────────────────────────

async function adminVerifyEmail(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "adminVerifyEmail", "standard");

  const userId = req.params["userId"];
  if (!userId) throw new HttpError(400, "MISSING_USER_ID", "Missing userId");

  const credPath = `auth/${userId}.json`;
  try {
    await withPrivateLease(credPath, async (leaseId) => {
      let cred;
      try {
        cred = await readJson(
          getPrivateBlobClient(credPath),
          AuthCredentialSchema,
          credPath,
        );
      } catch (err: unknown) {
        if (statusCodeOf(err) === 404) {
          throw new HttpError(404, "NOT_FOUND", "Auth credential not found");
        }
        throw err;
      }

      cred.emailVerified = true;
      await writePrivateJson(credPath, AuthCredentialSchema, cred, leaseId);
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    if (statusCodeOf(err) === 404) {
      throw new HttpError(404, "NOT_FOUND", "Auth credential not found");
    }
    rethrowLeaseConflict(err);
  }

  return { status: 200, jsonBody: { ok: true } };
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

app.http("adminVerifyEmail", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "manage/users/{userId}/verify-email",
  handler: withErrorHandler(adminVerifyEmail),
});
