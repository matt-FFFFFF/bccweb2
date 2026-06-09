/**
 * Site endpoints — Phase 2 + Phase 5
 *
 * GET  /api/sites      — site list (public)
 * POST /api/sites      — create site (Admin) — Phase 5
 * PUT  /api/sites/{id} — update site (Admin) — Phase 5
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "crypto";
import type { Site, SiteSummary, SiteStatus } from "@bccweb/types";
import { getBlobClient, getPrivateBlobClient, readBlob, writeBlob, writePrivateBlob } from "../lib/blob.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";

// ─── GET /api/sites ───────────────────────────────────────────────────────────

async function getSites(
  _req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const sites = await readBlob<SiteSummary[]>(getBlobClient("sites.json"));
    sites.sort((a, b) => a.name.localeCompare(b.name));
    return { status: 200, jsonBody: sites };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 200, jsonBody: [] };
    }
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── POST /api/sites ──────────────────────────────────────────────────────────

interface CreateSiteBody {
  name: string;
  clubId: string;
  status?: SiteStatus;
  parkingW3W?: string;
  briefingW3W?: string;
  takeOffW3W?: string;
  guideUrl?: string;
  contactInfo?: string;
}

async function createSite(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();

  let body: CreateSiteBody;
  try {
    body = (await req.json()) as CreateSiteBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  if (!body.name?.trim()) {
    throw new HttpError(400, "INVALID_BODY", "name is required");
  }
  if (!body.clubId) {
    throw new HttpError(400, "INVALID_BODY", "clubId is required");
  }

  const id = randomUUID();
  const site: Site = {
    id,
    name: body.name.trim(),
    status: body.status ?? "Active",
    clubId: body.clubId,
    parkingW3W: body.parkingW3W,
    briefingW3W: body.briefingW3W,
    takeOffW3W: body.takeOffW3W,
    guideUrl: body.guideUrl,
    contactInfo: body.contactInfo,
  };

  await writePrivateBlob(`sites/${id}.json`, site);
  await upsertSiteInIndex({
    id,
    name: site.name,
    status: site.status,
    clubId: site.clubId,
  });

  return { status: 201, jsonBody: site };
}

// ─── PUT /api/sites/{id} ──────────────────────────────────────────────────────

async function updateSite(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_SITE_ID", "Missing site id");

  let existing: Site;
  try {
    existing = await readBlob<Site>(getPrivateBlobClient(`sites/${id}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Site not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  let body: Partial<Site>;
  try {
    body = (await req.json()) as Partial<Site>;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  const updated: Site = {
    ...existing,
    name: body.name?.trim() ?? existing.name,
    status: body.status ?? existing.status,
    clubId: body.clubId ?? existing.clubId,
    parkingW3W: body.parkingW3W ?? existing.parkingW3W,
    briefingW3W: body.briefingW3W ?? existing.briefingW3W,
    takeOffW3W: body.takeOffW3W ?? existing.takeOffW3W,
    guideUrl: body.guideUrl ?? existing.guideUrl,
    contactInfo: body.contactInfo ?? existing.contactInfo,
    id: existing.id, // immutable
  };

  await writePrivateBlob(`sites/${id}.json`, updated);
  await upsertSiteInIndex({
    id,
    name: updated.name,
    status: updated.status,
    clubId: updated.clubId,
  });

  return { status: 200, jsonBody: updated };
}

// ─── Index helper ─────────────────────────────────────────────────────────────

async function upsertSiteInIndex(summary: SiteSummary): Promise<void> {
  let index: SiteSummary[] = [];
  try {
    index = await readBlob<SiteSummary[]>(getBlobClient("sites.json"));
  } catch {
    // index may not exist yet
  }

  const idx = index.findIndex((s) => s.id === summary.id);
  if (idx >= 0) {
    index[idx] = summary;
  } else {
    index.push(summary);
  }

  index.sort((a, b) => a.name.localeCompare(b.name));
  await writeBlob("sites.json", index);
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("getSites", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "sites",
  handler: withErrorHandler(getSites),
});

app.http("createSite", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "sites",
  handler: withErrorHandler(createSite),
});

app.http("updateSite", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "sites/{id}",
  handler: withErrorHandler(updateSite),
});
