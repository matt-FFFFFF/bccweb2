/**
 * Manufacturer endpoints
 *
 * GET    /api/manufacturers       — manufacturer list (public; anonymous read by the SPA)
 * POST   /api/manufacturers       — create manufacturer (Admin only)
 * PUT    /api/manufacturers/{id}  — update manufacturer name/website (Admin only; id immutable)
 * DELETE /api/manufacturers/{id}  — delete manufacturer (Admin only; idempotent, no reference guard)
 *
 * Storage: a SINGLE public list `manufacturers.json` in the `data` container.
 * There is no private per-manufacturer detail blob. Every index mutation runs as
 * a LEASED read-modify-write (mirrors the leased `removeClubFromIndex` in clubs.ts).
 */

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { randomUUID } from "crypto";
import type { Manufacturer } from "@bccweb/types";
import { ManufacturersIndexSchema } from "@bccweb/schemas";
import * as z from "zod/v4";
import { ensureJsonIndexBlob, getBlobClient, withLeaseRetry } from "../lib/blob.js";
import { readJson, writeJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";

const INDEX_PATH = "manufacturers.json";

const ManufacturerBodySchema = z
  .object({
    name: z.string().optional(),
    websiteUrl: z.string().optional(),
  })
  .strip();

interface ManufacturerIndexInput {
  readonly id: string;
  readonly name?: string;
  readonly websiteUrl?: string;
}

async function parseManufacturerBody(
  req: HttpRequest,
): Promise<z.infer<typeof ManufacturerBodySchema>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }
  const parsed = ManufacturerBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_BODY", "Invalid manufacturer body");
  }
  return parsed.data;
}

// ─── GET /api/manufacturers ────────────────────────────────────────────────────

async function getManufacturers(
  _req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const manufacturers = await readJson(
      getBlobClient(INDEX_PATH),
      ManufacturersIndexSchema,
      INDEX_PATH,
    );
    manufacturers.sort((a, b) => a.name.localeCompare(b.name));
    return { status: 200, jsonBody: manufacturers };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 200, jsonBody: [] };
    }
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── POST /api/manufacturers ───────────────────────────────────────────────────

async function createManufacturer(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();
  await mutationRateLimit(req, caller, "createManufacturer", "standard");

  const body = await parseManufacturerBody(req);
  const name = body.name?.trim();
  if (!name) {
    throw new HttpError(400, "INVALID_BODY", "name is required");
  }
  const websiteUrl = body.websiteUrl?.trim() || undefined;

  const id = randomUUID();
  const created = await upsertManufacturerInIndex(
    { id, name, ...(websiteUrl !== undefined ? { websiteUrl } : {}) },
    true,
  );

  return { status: 201, jsonBody: created };
}

// ─── PUT /api/manufacturers/{id} ───────────────────────────────────────────────

async function updateManufacturer(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();
  await mutationRateLimit(req, caller, "updateManufacturer", "standard");

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_MANUFACTURER_ID", "Missing manufacturer id");

  const body = await parseManufacturerBody(req);
  const name = body.name?.trim();
  if (body.name !== undefined && !name) {
    throw new HttpError(400, "INVALID_BODY", "name cannot be empty");
  }
  const websiteUrl = body.websiteUrl?.trim() || undefined;

  // insertIfMissing = false → replace-in-place or 404 (never insert). The lease
  // holder throws NOT_FOUND before writing, so a missing id leaves the list UNCHANGED.
  const updated = await upsertManufacturerInIndex(
    {
      id,
      ...(name ? { name } : {}),
      ...(websiteUrl !== undefined ? { websiteUrl } : {}),
    },
    false,
  );

  return { status: 200, jsonBody: updated };
}

// ─── DELETE /api/manufacturers/{id} ────────────────────────────────────────────

async function deleteManufacturer(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();
  await mutationRateLimit(req, caller, "deleteManufacturer", "standard");

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_MANUFACTURER_ID", "Missing manufacturer id");

  // Idempotent: removing an unknown id rewrites the same list and still returns 204.
  await removeManufacturerFromIndex(id);

  return { status: 204 };
}

// ─── Index helpers (leased read-modify-write) ──────────────────────────────────

async function upsertManufacturerInIndex(
  input: ManufacturerIndexInput,
  insertIfMissing: boolean,
): Promise<Manufacturer> {
  await ensureJsonIndexBlob(INDEX_PATH, "[]");

  let stored: Manufacturer | undefined;
  await withLeaseRetry(INDEX_PATH, async (leaseId) => {
    let index: Manufacturer[] = [];
    try {
      index = await readJson(getBlobClient(INDEX_PATH), ManufacturersIndexSchema, INDEX_PATH);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }

    const existing = index.find((m) => m.id === input.id);
    if (existing) {
      const next: Manufacturer = {
        ...existing,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.websiteUrl !== undefined ? { websiteUrl: input.websiteUrl } : {}),
        id: existing.id, // immutable
      };
      index = index.map((m) => (m.id === next.id ? next : m));
      stored = next;
    } else if (insertIfMissing) {
      if (input.name === undefined) {
        throw new HttpError(400, "INVALID_BODY", "name is required");
      }
      const next: Manufacturer = {
        id: input.id,
        name: input.name,
        ...(input.websiteUrl !== undefined ? { websiteUrl: input.websiteUrl } : {}),
      };
      index = [...index, next];
      stored = next;
    } else {
      throw new HttpError(404, "NOT_FOUND", "Manufacturer not found");
    }

    index.sort((a, b) => a.name.localeCompare(b.name));
    await writeJson(INDEX_PATH, ManufacturersIndexSchema, index, leaseId);
  });

  if (stored === undefined) throw new HttpError(500, "INTERNAL");
  return stored;
}

async function removeManufacturerFromIndex(id: string): Promise<void> {
  await ensureJsonIndexBlob(INDEX_PATH, "[]");
  await withLeaseRetry(INDEX_PATH, async (leaseId) => {
    let index: Manufacturer[] = [];
    try {
      index = await readJson(getBlobClient(INDEX_PATH), ManufacturersIndexSchema, INDEX_PATH);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
    await writeJson(
      INDEX_PATH,
      ManufacturersIndexSchema,
      index.filter((m) => m.id !== id),
      leaseId,
    );
  });
}

// ─── Registration ──────────────────────────────────────────────────────────────

app.http("getManufacturers", { methods: ["GET"], authLevel: "anonymous", route: "manufacturers", handler: withErrorHandler(getManufacturers) });
app.http("createManufacturer", { methods: ["POST"], authLevel: "anonymous", route: "manufacturers", handler: withErrorHandler(createManufacturer) });
app.http("updateManufacturer", { methods: ["PUT"], authLevel: "anonymous", route: "manufacturers/{id}", handler: withErrorHandler(updateManufacturer) });
app.http("deleteManufacturer", { methods: ["DELETE"], authLevel: "anonymous", route: "manufacturers/{id}", handler: withErrorHandler(deleteManufacturer) });
