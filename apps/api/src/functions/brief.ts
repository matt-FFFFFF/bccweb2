/**
 * Round Brief endpoints — Phase 4
 *
 * GET  /api/rounds/{id}/brief      — returns the stored RoundBrief JSON
 * GET  /api/rounds/{id}/brief/pdf  — streams the stored PDF from blob storage
 * GET  /api/rounds/{id}/brief/images/{n} — streams a private brief image
 */

import { randomUUID } from "node:crypto";
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { RoundBrief } from "@bccweb/types";
import { BriefSchema, RoundSchema, BriefEditableSchema, BRIEF_EDITABLE_KEYS } from "@bccweb/schemas";
import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  withRoundAndBriefLease,
} from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { canViewRoundDetail, assertCanManageRound } from "../lib/roundAuth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import { buildInitialBrief } from "./roundsMutate.js";
import type { CallerIdentity, Round } from "@bccweb/types";

function contentTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function matchesMagicBytes(fileType: string, buffer: Buffer): boolean {
  if (fileType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }

  if (fileType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  return false;
}

async function readBrief(id: string): Promise<RoundBrief | null> {
  const path = `round-briefs/${id}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), BriefSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw new HttpError(500, "INTERNAL");
  }
}

async function assertCanViewRound(
  caller: CallerIdentity,
  id: string,
): Promise<void> {
  const path = `rounds/${id}.json`;
  let round: Round;
  try {
    round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }
  if (!canViewRoundDetail(caller, round)) {
    throw new HttpError(403, "FORBIDDEN", "You do not have access to this round's brief");
  }
}

// ─── GET /api/rounds/{id}/brief ───────────────────────────────────────────────

async function getRoundBrief(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  await assertCanViewRound(caller, id);

  const brief = await readBrief(id);
  if (!brief) {
    return {
      status: 404,
      jsonBody: {
        error:
          "Round brief not found. The round may not be locked yet, or brief generation is in progress.",
      },
    };
  }

  return { status: 200, jsonBody: brief };
}

// ─── GET /api/rounds/{id}/brief/pdf ──────────────────────────────────────────

async function getRoundBriefPdf(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  await assertCanViewRound(caller, id);

  // Non-JSON pdf binary: use BlobClient.download() not readBlob/readJson (see "PREFER readJson" doc in lib/blob.ts).
  const blobClient = getPrivateBlobClient(`round-briefs/${id}.pdf`);

  let downloadRes: Awaited<ReturnType<typeof blobClient.download>>;
  try {
    downloadRes = await blobClient.download();
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return {
        status: 404,
        jsonBody: {
          error:
            "Round brief PDF not found. The round may not be locked yet, or PDF generation is in progress.",
        },
      };
    }
    throw new HttpError(500, "INTERNAL");
  }

  // Read the stream into a buffer and return as binary response
  const pdfBuffer = await streamToBuffer(downloadRes.readableStreamBody!);

  // Try to extract site name from blob metadata for a useful filename
  const siteName =
    (downloadRes.metadata?.["sitename"]) ?? "round-brief";
  const dateStr =
    (downloadRes.metadata?.["date"]) ?? "";
  const filename = `BCC-Brief-${siteName.replace(/\s+/g, "-")}-${dateStr}.pdf`
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-");

  return {
    status: 200,
    body: pdfBuffer,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdfBuffer.length),
      "Cache-Control": "private, max-age=300",
    },
  };
}

async function getRoundBriefImage(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const imageNumber = Number(req.params["n"]);
  if (!Number.isInteger(imageNumber) || imageNumber < 1) {
    throw new HttpError(400, "INVALID_IMAGE_NUMBER", "Invalid image number");
  }

  await assertCanViewRound(caller, id);

  const brief = await readBrief(id);
  if (!brief) {
    return { status: 404, jsonBody: { error: "Round brief not found." } };
  }

  const imagePath = brief.imagePaths?.[imageNumber - 1];
  if (!imagePath || !imagePath.startsWith(`round-briefs/${id}/`)) {
    return { status: 404, jsonBody: { error: "Brief image not found." } };
  }

  // Non-JSON image binary (.jpg/.png): use BlobClient.download() not readBlob/readJson (see "PREFER readJson" doc in lib/blob.ts).
  const blobClient = getPrivateBlobClient(imagePath);
  let downloadRes: Awaited<ReturnType<typeof blobClient.download>>;
  try {
    downloadRes = await blobClient.download();
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 404, jsonBody: { error: "Brief image not found." } };
    }
    throw new HttpError(500, "INTERNAL");
  }

  const imageBuffer = await streamToBuffer(downloadRes.readableStreamBody!);
  const contentType = downloadRes.contentType ?? contentTypeForPath(imagePath);

  return {
    status: 200,
    body: imageBuffer,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(imageBuffer.length),
      "Cache-Control": "private, max-age=300",
    },
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("getRoundBrief", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rounds/{id}/brief",
  handler: withErrorHandler(getRoundBrief),
});

app.http("getRoundBriefPdf", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rounds/{id}/brief/pdf",
  handler: withErrorHandler(getRoundBriefPdf),
});

app.http("getRoundBriefImage", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rounds/{id}/brief/images/{n}",
  handler: withErrorHandler(getRoundBriefImage),
});

// ─── PUT /api/rounds/{id}/brief ───────────────────────────────────────────────

async function updateRoundBrief(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  if (!caller.roles.includes("Admin") && !caller.roles.includes("RoundsCoord")) {
    throw new HttpError(403, "FORBIDDEN");
  }

  const round = await readJson(
    getPrivateBlobClient(`rounds/${id}.json`),
    RoundSchema,
    `rounds/${id}.json`,
  ).catch((e: unknown) => {
    if ((e as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw e;
  });

  assertCanManageRound(caller, round);

  await mutationRateLimit(req, caller, "updateRoundBrief", "heavy");

  const parsed = BriefEditableSchema.safeParse(await req.json());
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_BODY", "Invalid brief edit body");
  }
  const edits = parsed.data as Record<string, unknown>;

  // Lazy-create: you cannot lease a missing blob, so create-or-skip the brief
  // (ifNoneMatch:"*" — 409/412 = a concurrent create won, treat as no-op)
  // BEFORE acquiring the cross-blob lease.
  if (!(await readBrief(id))) {
    const seed = await buildInitialBrief(round, {
      briefingTime: edits["briefingTime"] as string | undefined,
      checkInByTime: edits["checkInByTime"] as string | undefined,
      landByTime: edits["landByTime"] as string | undefined,
    });
    try {
      await writePrivateJson(`round-briefs/${id}.json`, BriefSchema, seed, undefined, {
        ifNoneMatch: "*",
      });
    } catch (e: unknown) {
      const sc = (e as { statusCode?: number }).statusCode;
      if (sc !== 409 && sc !== 412) throw e;
    }
  }

  const merged = await withRoundAndBriefLease(id, async (_roundLeaseId, briefLeaseId) => {
    const current = await readJson(
      getPrivateBlobClient(`rounds/${id}.json`),
      RoundSchema,
      `rounds/${id}.json`,
    );
    if (current.status !== "Proposed" && current.status !== "Confirmed") {
      throw new HttpError(
        409,
        "BRIEF_LOCKED",
        "Brief can only be edited while the round is Proposed or Confirmed.",
      );
    }

    const existing = await readBrief(id);
    if (!existing) throw new HttpError(404, "NOT_FOUND", "Brief not found");

    const next = { ...existing } as Record<string, unknown>;
    for (const key of BRIEF_EDITABLE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(edits, key)) {
        next[key] = edits[key];
      }
    }

    await writePrivateJson(`round-briefs/${id}.json`, BriefSchema, next as unknown as RoundBrief, briefLeaseId);
    return next as unknown as RoundBrief;
  });

  return { status: 200, jsonBody: merged };
}

// ─── POST /api/rounds/{id}/brief/images ───────────────────────────────────────

// CAS create-only so withRoundAndBriefLease has a blob to lease; a concurrent
// first-upload that already created it 409/412s, swallowed as a no-op (R3).
async function ensureBriefExists(id: string, round: Round): Promise<void> {
  if (await readBrief(id)) return;
  const seed = await buildInitialBrief(round);
  try {
    await writePrivateJson(`round-briefs/${id}.json`, BriefSchema, seed, undefined, {
      ifNoneMatch: "*",
    });
  } catch (e: unknown) {
    const sc = (e as { statusCode?: number }).statusCode;
    if (sc !== 409 && sc !== 412) throw e;
  }
}

async function uploadBriefImage(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID");

  // Unleased read is for AUTH + lazy-create seed ONLY. The authoritative status
  // gate is re-read UNDER the round lease below (B3) — never trusted from here.
  const round = await readJson(
    getPrivateBlobClient(`rounds/${id}.json`),
    RoundSchema,
    `rounds/${id}.json`,
  ).catch((e) => {
    if ((e as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw e;
  });

  if (!caller.roles.includes("Admin") && !caller.roles.includes("RoundsCoord")) {
    throw new HttpError(403, "FORBIDDEN");
  }
  if (!caller.roles.includes("Admin") && caller.roles.includes("RoundsCoord") && caller.clubId !== round.organisingClub?.id) {
    throw new HttpError(403, "FORBIDDEN");
  }
  await mutationRateLimit(req, caller, "uploadBriefImage", "standard");

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) throw new HttpError(400, "BAD_REQUEST", "Missing file");

  if (file.size > 5 * 1024 * 1024) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Max 5MB");
  }

  if (!["image/jpeg", "image/png"].includes(file.type)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Only JPEG/PNG");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!matchesMagicBytes(file.type, buffer)) {
    throw new HttpError(400, "IMAGE_MAGIC_MISMATCH", "Image bytes do not match the declared type");
  }
  const ext = file.type === "image/png" ? "png" : "jpg";

  await ensureBriefExists(id, round);

  const savedPath = await withRoundAndBriefLease(id, async (_roundLeaseId, briefLeaseId) => {
    // B3: re-read the round status UNDER the round lease and reject any frozen /
    // locked state HERE. imagePaths is material, so an append after T7 freezes
    // the hash would silently break the T8 lock assertion — gate it under lease.
    const current = await readJson(
      getPrivateBlobClient(`rounds/${id}.json`),
      RoundSchema,
      `rounds/${id}.json`,
    );
    if (current.status !== "Proposed" && current.status !== "Confirmed") {
      throw new HttpError(
        409,
        "BRIEF_LOCKED",
        "Brief images can only be changed while the round is Proposed or Confirmed.",
      );
    }

    const existing = await readBrief(id);
    if (!existing) throw new HttpError(404, "NOT_FOUND", "Brief not found");
    if ((existing.imagePaths?.length || 0) >= 10) {
      throw new HttpError(400, "TOO_MANY_IMAGES", "A brief may hold at most 10 images.");
    }

    // crypto UUID name — NEVER reuse an index. A delete+reupload must yield a
    // fresh path (no stale-blob collision) and register as a material change.
    const imagePath = `round-briefs/${id}/${randomUUID()}.${ext}`;
    await getPrivateBlockBlobClient(imagePath).upload(buffer, buffer.length, {
      blobHTTPHeaders: { blobContentType: file.type },
    });

    existing.imagePaths = existing.imagePaths || [];
    existing.imagePaths.push(imagePath);
    await writePrivateJson(`round-briefs/${id}.json`, BriefSchema, existing, briefLeaseId);
    return imagePath;
  });

  return { status: 200, jsonBody: { path: savedPath } };
}

// ─── DELETE /api/rounds/{id}/brief/images/{index} ───────────────────────────

async function deleteBriefImage(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  const n = Number(req.params["index"]);
  if (!id || !n) throw new HttpError(400, "BAD_REQUEST");

  const round = await readJson(
    getPrivateBlobClient(`rounds/${id}.json`),
    RoundSchema,
    `rounds/${id}.json`,
  ).catch((e) => {
    if ((e as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw e;
  });

  if (!caller.roles.includes("Admin") && !caller.roles.includes("RoundsCoord")) {
    throw new HttpError(403, "FORBIDDEN");
  }
  if (!caller.roles.includes("Admin") && caller.roles.includes("RoundsCoord") && caller.clubId !== round.organisingClub?.id) {
    throw new HttpError(403, "FORBIDDEN");
  }
  await mutationRateLimit(req, caller, "deleteBriefImage", "standard");

  // No lazy-create on delete; a missing brief is a 404 and also can't be leased.
  if (!(await readBrief(id))) {
    throw new HttpError(404, "NOT_FOUND", "Image not found");
  }

  await withRoundAndBriefLease(id, async (_roundLeaseId, briefLeaseId) => {
    // B3: gate the material imagePaths change on the round status, re-read here
    // under the round lease (never trusted from the unleased read above).
    const current = await readJson(
      getPrivateBlobClient(`rounds/${id}.json`),
      RoundSchema,
      `rounds/${id}.json`,
    );
    if (current.status !== "Proposed" && current.status !== "Confirmed") {
      throw new HttpError(
        409,
        "BRIEF_LOCKED",
        "Brief images can only be changed while the round is Proposed or Confirmed.",
      );
    }

    const existing = await readBrief(id);
    if (!existing || !existing.imagePaths || !existing.imagePaths[n - 1]) {
      throw new HttpError(404, "NOT_FOUND", "Image not found");
    }

    const imagePath = existing.imagePaths[n - 1];
    existing.imagePaths.splice(n - 1, 1);
    await writePrivateJson(`round-briefs/${id}.json`, BriefSchema, existing, briefLeaseId);

    await getPrivateBlockBlobClient(imagePath).deleteIfExists();
  });

  return { status: 204 };
}

app.http("updateRoundBrief", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "rounds/{id}/brief",
  handler: withErrorHandler(updateRoundBrief),
});

app.http("uploadBriefImage", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/brief/images",
  handler: withErrorHandler(uploadBriefImage),
});

app.http("deleteBriefImage", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "rounds/{id}/brief/images/{index}",
  handler: withErrorHandler(deleteBriefImage),
});
