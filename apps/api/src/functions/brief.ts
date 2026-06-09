/**
 * Round Brief endpoints — Phase 4
 *
 * GET  /api/rounds/{id}/brief      — returns the stored RoundBrief JSON
 * GET  /api/rounds/{id}/brief/pdf  — streams the stored PDF from blob storage
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { RoundBrief } from "@bccweb/types";
import { getPrivateBlobClient, readBlob } from "../lib/blob.js";

// ─── GET /api/rounds/{id}/brief ───────────────────────────────────────────────

async function getRoundBrief(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) return { status: 400, jsonBody: { error: "Missing round id" } };

  let brief: RoundBrief;
  try {
    brief = await readBlob<RoundBrief>(
      getPrivateBlobClient(`round-briefs/${id}.json`)
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return {
        status: 404,
        jsonBody: {
          error:
            "Round brief not found. The round may not be locked yet, or brief generation is in progress.",
        },
      };
    }
    throw err;
  }

  return { status: 200, jsonBody: brief };
}

// ─── GET /api/rounds/{id}/brief/pdf ──────────────────────────────────────────

async function getRoundBriefPdf(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) return { status: 400, jsonBody: { error: "Missing round id" } };

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
    throw err;
  }

  // Read the stream into a buffer and return as binary response
  const chunks: Buffer[] = [];
  for await (const chunk of downloadRes.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const pdfBuffer = Buffer.concat(chunks);

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

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("getRoundBrief", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rounds/{id}/brief",
  handler: getRoundBrief,
});

app.http("getRoundBriefPdf", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rounds/{id}/brief/pdf",
  handler: getRoundBriefPdf,
});
