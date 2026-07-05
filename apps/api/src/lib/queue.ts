import { QueueClient } from "@azure/storage-queue";
import * as z from "zod/v4";

// ─── Brief-PDF job contract ───────────────────────────────────────────────────

export interface BriefPdfJob {
  roundId: string;
  briefVersion: number;
  pdfAttemptId: string;
}

// STRICT on purpose. The storage queue is NOT covered by the public-container
// privacy scanner (scripts/privacy-scan.mjs), so `.strict()` is the compensating
// control: it rejects ANY extra key (e.g. a PII field) at parse time, before the
// job can be serialised into a queue message. Never add a field here beyond
// { roundId, briefVersion, pdfAttemptId }, and never drop `.strict()`.
//
// Key order matters: Zod `.parse` on a `z.object` preserves the declared key
// order, so declaring keys as roundId → briefVersion → pdfAttemptId fixes the
// JSON byte layout the consumer (a v4 storage-queue trigger that base64-decodes
// then JSON-parses) receives.
export const BriefPdfJobSchema = z
  .object({
    roundId: z.string().min(1),
    briefVersion: z.number().int(),
    pdfAttemptId: z.string().min(1),
  })
  .strict();

// ─── Client singleton ─────────────────────────────────────────────────────────

const QUEUE_NAME = "round-brief-pdf";

let _queueClient: QueueClient | null = null;

// TEST-ONLY: clears the cached QueueClient so the next enqueue re-reads
// AzureWebJobsStorage from env. Mirrors resetBlobSingletons in lib/blob.ts;
// wired into __tests__/helpers/setup.ts so each test file starts clean.
export function resetQueueSingletons(): void {
  _queueClient = null;
}

function getQueueClient(): QueueClient {
  if (_queueClient) return _queueClient;
  // AzureWebJobsStorage is the ONLY setting carrying a QueueEndpoint in
  // local/docker, and it equals the queue trigger's `connection`, so producer
  // and trigger can never diverge. Do NOT fall back to BLOB_CONNECTION_STRING
  // (blob-only) — that would silently break queueing.
  const connectionString = process.env["AzureWebJobsStorage"];
  if (!connectionString) {
    throw new Error(
      "AzureWebJobsStorage environment variable is not set (required to enqueue brief-PDF jobs)",
    );
  }
  _queueClient = new QueueClient(connectionString, QUEUE_NAME);
  return _queueClient;
}

// ─── Producer ─────────────────────────────────────────────────────────────────

/**
 * Enqueue a brief-PDF render job onto the `round-brief-pdf` queue.
 *
 * Parses the job FIRST (strict schema) so a bad/extra field is rejected before
 * anything is serialised — no PII can leak into a queue message. The validated
 * JSON is base64-encoded to match the v4 storage-queue trigger, which
 * base64-decodes then JSON-parses the message body.
 */
export async function enqueueBriefPdf(job: BriefPdfJob): Promise<void> {
  const parsed = BriefPdfJobSchema.parse(job);
  const message = Buffer.from(JSON.stringify(parsed)).toString("base64");
  await getQueueClient().sendMessage(message);
}
