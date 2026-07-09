// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { app, type InvocationContext } from "@azure/functions";
import { BriefSchema, RoundSchema } from "@bccweb/schemas";

import { getPrivateBlobClient } from "../lib/blob.js";
import { readJson } from "../lib/blobJson.js";
import {
  commitBriefPdfReady,
  sendBriefIfConfigured,
  setBriefPdfStatus,
} from "../lib/briefPdf.js";
import { generateBriefPdf } from "../lib/pdf.js";
import { BriefPdfJobSchema } from "../lib/queue.js";
import { getTelemetryClient } from "../lib/telemetry.js";
import { redactObject } from "../lib/telemetryRedactor.js";
import type { BriefPdfStatus } from "@bccweb/types";

const MAX_DEQUEUE = 5;
const RETRYABLE_STATUSES: BriefPdfStatus[] = ["pending", "failed"];
const FINAL_FAILURE_STATUSES: BriefPdfStatus[] = ["pending", "processing"];

type QueueMessage = unknown;

function parseQueueMessage(message: QueueMessage) {
  const raw: unknown = typeof message === "string" ? JSON.parse(message) : message;
  return BriefPdfJobSchema.parse(raw);
}

function pdfErrorCode(err: unknown): string {
  if (err instanceof Error && err.name.length > 0) return err.name;
  return "BriefPdfGenerationFailed";
}

export async function handleBriefPdfJob(
  message: QueueMessage,
  ctx: InvocationContext,
): Promise<void> {
  const { roundId, briefVersion, pdfAttemptId } = parseQueueMessage(message);
  void briefVersion;

  const roundPath = `rounds/${roundId}.json`;
  const round = await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
  if (round.brief?.pdfAttemptId !== pdfAttemptId) return;
  if (round.brief?.pdfStatus === "ready") return;

  await setBriefPdfStatus(roundId, "processing", {
    expectAttemptId: pdfAttemptId,
    fromStatuses: RETRYABLE_STATUSES,
  });

  try {
    const briefPath = `round-briefs/${roundId}.json`;
    const brief = await readJson(getPrivateBlobClient(briefPath), BriefSchema, briefPath);
    const buf = await generateBriefPdf(brief);
    const { committed } = await commitBriefPdfReady(roundId, buf, {
      expectAttemptId: pdfAttemptId,
      siteName: brief.siteName,
      date: brief.date,
    });
    if (committed) await sendBriefIfConfigured(brief, buf);
  } catch (err: unknown) {
    const dequeueCount = Number(ctx.triggerMetadata?.["dequeueCount"] ?? 1);
    if (dequeueCount < MAX_DEQUEUE) throw err;
    await setBriefPdfStatus(roundId, "failed", {
      error: pdfErrorCode(err),
      expectAttemptId: pdfAttemptId,
      fromStatuses: FINAL_FAILURE_STATUSES,
    });
  }
}

export async function handleBriefPdfPoison(message: QueueMessage): Promise<void> {
  try {
    const { roundId, pdfAttemptId } = parseQueueMessage(message);
    await setBriefPdfStatus(roundId, "failed", {
      error: "poison",
      expectAttemptId: pdfAttemptId,
      fromStatuses: FINAL_FAILURE_STATUSES,
    });
  } catch (err: unknown) {
    getTelemetryClient()?.trackEvent({
      name: "brief.poisonUnparseable",
      properties: redactObject({ error: pdfErrorCode(err) }) as Record<string, unknown>,
    });
  }
}

// host.json intentionally sets batchSize:1 because Puppeteer renders are memory-heavy.
// Its visibilityTimeout is only retry delay; correctness comes from pdfAttemptId + CAS commit.
app.storageQueue("briefPdf", {
  queueName: "round-brief-pdf",
  connection: "AzureWebJobsStorage",
  handler: handleBriefPdfJob,
});

app.storageQueue("briefPdfPoison", {
  queueName: "round-brief-pdf-poison",
  connection: "AzureWebJobsStorage",
  handler: handleBriefPdfPoison,
});
