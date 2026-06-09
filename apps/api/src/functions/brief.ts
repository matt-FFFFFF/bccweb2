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
import { getPrivateBlobClient, readBlob } from "../lib/blob.js";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";

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
