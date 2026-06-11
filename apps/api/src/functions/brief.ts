/**
 * Round Brief endpoints — Phase 4
 *
 * GET  /api/rounds/{id}/brief      — returns the stored RoundBrief JSON
 * GET  /api/rounds/{id}/brief/pdf  — streams the stored PDF from blob storage
 * GET  /api/rounds/{id}/brief/images/{n} — streams a private brief image
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { RoundBrief } from "@bccweb/types";
import {
  getPrivateBlobClient,
  readBlob,
  writePrivateBlob,
  withPrivateLeaseRenewing,
  getPrivateBlockBlobClient,
} from "../lib/blob.js";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import { computeBriefHash } from "../lib/signTofly/briefVersion.js";
import { invalidatePriorSignToFlyFlags } from "../lib/signTofly/invalidate.js";
import { listSignaturesForRound } from "../lib/signTofly/ledger.js";
import { generateBriefPdf } from "../lib/pdf.js";
import type { Round } from "@bccweb/types";

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
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
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
  try {
    return await readBlob<RoundBrief>(
      getPrivateBlobClient(`round-briefs/${id}.json`)
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw new HttpError(500, "INTERNAL");
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
    (downloadRes.metadata?.["sitename"] as string | undefined) ?? "round-brief";
  const dateStr =
    (downloadRes.metadata?.["date"] as string | undefined) ?? "";
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

  const brief = await readBrief(id);
  if (!brief) {
    return { status: 404, jsonBody: { error: "Round brief not found." } };
  }

  const imagePath = brief.imagePaths?.[imageNumber - 1];
  if (!imagePath || !imagePath.startsWith(`round-briefs/${id}/`)) {
    return { status: 404, jsonBody: { error: "Brief image not found." } };
  }

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

  // Auth: Admin OR RoundsCoord scoped to the round's club
  if (!caller.roles.includes("Admin") && !caller.roles.includes("RoundsCoord")) {
    throw new HttpError(403, "FORBIDDEN");
  }
  await mutationRateLimit(req, caller, "updateRoundBrief", "heavy");

  const round = await readBlob<Round>(getPrivateBlobClient(`rounds/${id}.json`)).catch((e) => {
    if ((e as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw e;
  });

  if (!caller.roles.includes("Admin") && caller.roles.includes("RoundsCoord") && caller.clubId !== round.organisingClub?.id) {
    throw new HttpError(403, "FORBIDDEN");
  }

  if (round.status === "Locked" || round.status === "Complete") {
    throw new HttpError(409, "BRIEF_LOCKED", "Round is locked or complete.");
  }

  const body = (await req.json()) as RoundBrief;
  const isDryRun = req.query.get("dryRun") === "true";

  const result = await withPrivateLeaseRenewing(`round-briefs/${id}.json`, async (leaseId) => {
    const existing = await readBrief(id);
    if (!existing) throw new HttpError(404, "NOT_FOUND", "Brief not found");

    const prevHash = computeBriefHash(existing);
    const nextHash = computeBriefHash(body);

    if (prevHash === nextHash) {
      // Cosmetic
      body.version = existing.version ?? 1;
      body.versionHistory = existing.versionHistory;
      
      if (!isDryRun) {
        await writePrivateBlob(`round-briefs/${id}.json`, body, leaseId);
      }
      return { brief: body, materialChanged: false, invalidatedSignatureCount: 0 };
    }

    // Material change
    const nextVersion = (existing.version ?? 1) + 1;
    const now = new Date().toISOString();
    
    body.version = nextVersion;
    body.versionHistory = existing.versionHistory ?? [];
    body.versionHistory.push({
      version: existing.version ?? 1,
      hash: prevHash,
      createdAt: existing.generatedAt || now,
      createdBy: "legacy",
      supersededAt: now
    });

    if (!isDryRun) {
      await writePrivateBlob(`round-briefs/${id}.json`, body, leaseId);
    }

    const signatures = await listSignaturesForRound(id);
    const mockRound = JSON.parse(JSON.stringify(round)) as Round;
    const updatedRound = invalidatePriorSignToFlyFlags(mockRound, body, signatures);

    let count = 0;
    for (const t1 of round.teams) {
      for (const p1 of t1.pilots) {
        const t2 = updatedRound.teams.find((t) => t.id === t1.id);
        const p2 = t2?.pilots.find((p) => p.placeInTeam === p1.placeInTeam);
        if (p1.signToFly === true && p2?.signToFly === false) {
          count++;
        }
      }
    }

    if (!isDryRun && count > 0) {
      await withPrivateLeaseRenewing(`rounds/${id}.json`, async (roundLease) => {
        await writePrivateBlob(`rounds/${id}.json`, updatedRound, roundLease);
      });
    }

    return { brief: body, materialChanged: true, invalidatedSignatureCount: count };
  });

  if (!isDryRun) {
    // Generate PDF outside lease
    try {
      const pdfBuffer = await generateBriefPdf(result.brief);
      const pdfClient = getPrivateBlockBlobClient(`round-briefs/${id}.pdf`);
      await pdfClient.upload(pdfBuffer, pdfBuffer.length, {
        blobHTTPHeaders: { blobContentType: "application/pdf" },
      });
    } catch (e) {
      _ctx.warn("Failed to generate PDF on brief edit", e);
    }
  }

  return { status: 200, jsonBody: result };
}

// ─── POST /api/rounds/{id}/brief/images ───────────────────────────────────────

async function uploadBriefImage(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID");

  const round = await readBlob<Round>(getPrivateBlobClient(`rounds/${id}.json`)).catch((e) => {
    if ((e as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw e;
  });

  if (!caller.roles.includes("Admin") && !caller.roles.includes("RoundsCoord")) {
    throw new HttpError(403, "FORBIDDEN");
  }
  await mutationRateLimit(req, caller, "uploadBriefImage", "standard");
  if (!caller.roles.includes("Admin") && caller.roles.includes("RoundsCoord") && caller.clubId !== round.organisingClub?.id) {
    throw new HttpError(403, "FORBIDDEN");
  }
  if (round.status === "Locked" || round.status === "Complete") {
    throw new HttpError(409, "BRIEF_LOCKED", "Round is locked or complete.");
  }

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
  const brief = await readBrief(id);
  if (!brief) throw new HttpError(404, "NOT_FOUND", "Brief not found");
  if ((brief.imagePaths?.length || 0) >= 10) {
    return {
      status: 400,
      jsonBody: { error: "TOO_MANY_IMAGES", code: "TOO_MANY_IMAGES" },
    };
  }
  if (!matchesMagicBytes(file.type, buffer)) {
    return {
      status: 400,
      jsonBody: { error: "IMAGE_MAGIC_MISMATCH", code: "IMAGE_MAGIC_MISMATCH" },
    };
  }

  const nextN = (brief.imagePaths?.length || 0) + 1;
  const ext = file.type === "image/png" ? "png" : "jpg";
  const imagePath = `round-briefs/${id}/image-${nextN}.${ext}`;

  const imageClient = getPrivateBlockBlobClient(imagePath);
  await imageClient.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: file.type },
  });

  let savedPath = "";
  await withPrivateLeaseRenewing(`round-briefs/${id}.json`, async (leaseId) => {
    const existing = await readBrief(id);
    if (!existing) throw new HttpError(404, "NOT_FOUND");
    existing.imagePaths = existing.imagePaths || [];
    existing.imagePaths.push(imagePath);
    savedPath = imagePath;
    await writePrivateBlob(`round-briefs/${id}.json`, existing, leaseId);
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

  const round = await readBlob<Round>(getPrivateBlobClient(`rounds/${id}.json`)).catch((e) => {
    if ((e as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw e;
  });

  if (!caller.roles.includes("Admin") && !caller.roles.includes("RoundsCoord")) {
    throw new HttpError(403, "FORBIDDEN");
  }
  await mutationRateLimit(req, caller, "deleteBriefImage", "standard");
  if (!caller.roles.includes("Admin") && caller.roles.includes("RoundsCoord") && caller.clubId !== round.organisingClub?.id) {
    throw new HttpError(403, "FORBIDDEN");
  }
  if (round.status === "Locked" || round.status === "Complete") {
    throw new HttpError(409, "BRIEF_LOCKED", "Round is locked or complete.");
  }

  await withPrivateLeaseRenewing(`round-briefs/${id}.json`, async (leaseId) => {
    const existing = await readBrief(id);
    if (!existing || !existing.imagePaths || !existing.imagePaths[n - 1]) {
      throw new HttpError(404, "NOT_FOUND", "Image not found");
    }

    const imagePath = existing.imagePaths[n - 1];
    existing.imagePaths.splice(n - 1, 1);
    await writePrivateBlob(`round-briefs/${id}.json`, existing, leaseId);

    const imageClient = getPrivateBlockBlobClient(imagePath);
    await imageClient.deleteIfExists();
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
