// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { app, type InvocationContext } from "@azure/functions";
import { RoundSchema } from "@bccweb/schemas";
import type { RescoreJob, RescoreJobMessage } from "@bccweb/types";

import { getPrivateBlobClient } from "../lib/blob.js";
import { readJson } from "../lib/blobJson.js";
import { recomputeSeason } from "../lib/recompute.js";
import {
  readJobStatus,
  releaseActiveGuard,
  RESCORE_QUEUE_NAME,
  RescoreJobMessageSchema,
  writeJobStatus,
} from "../lib/rescoreJob.js";
import { runRescoreJob } from "./rescoreRound.js";

function parseRescoreMessage(message: unknown): RescoreJobMessage | null {
  const raw: unknown = typeof message === "string" ? JSON.parse(message) : message;
  const parsed = RescoreJobMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readRoundSeasonYear(roundId: string): Promise<number> {
  const path = `rounds/${roundId}.json`;
  const round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
  return round.season.year;
}

async function markJobFailed(job: RescoreJob, err: unknown): Promise<void> {
  job.status = "failed";
  job.finishedAt = new Date().toISOString();
  job.errors = [
    ...(job.errors ?? []),
    { teamId: "", place: 0, error: errorMessage(err) },
  ];
  await writeJobStatus(job);
}

export async function rescoreWorker(
  message: unknown,
  ctx: InvocationContext,
): Promise<void> {
  let msg: RescoreJobMessage | null;
  try {
    msg = parseRescoreMessage(message);
  } catch (err: unknown) {
    ctx.warn("[rescoreWorker] malformed rescore message", err);
    return;
  }

  if (msg === null) {
    ctx.warn("[rescoreWorker] malformed rescore message", message);
    return;
  }

  try {
    const job = await readJobStatus(msg.jobId);
    if (job === null) {
      ctx.warn(`[rescoreWorker] job status not found for ${msg.jobId}`);
      return;
    }

    const finished = await runRescoreJob(msg.roundId, job, ctx);
    void finished;
    // Best-effort season recompute. The job is already terminal here
    // (runRescoreJob wrote completed/partial), so a transient failure of the
    // post-completion round read MUST NOT reach the outer catch and flip the
    // job to `failed`. Isolate it in its own try/catch.
    try {
      const year = await readRoundSeasonYear(msg.roundId);
      recomputeSeason(year).catch((err: unknown) => {
        ctx.error(`[rescoreWorker] recomputeSeason(${year}) failed:`, err);
      });
    } catch (err: unknown) {
      ctx.error(
        `[rescoreWorker] post-rescore season recompute setup failed for job ${msg.jobId}:`,
        err,
      );
    }
  } catch (err: unknown) {
    const job = await readJobStatus(msg.jobId);
    if (job !== null) await markJobFailed(job, err);
    ctx.error(`[rescoreWorker] rescore job ${msg.jobId} failed:`, err);
  } finally {
    await releaseActiveGuard(msg.roundId);
  }
}

app.storageQueue("rescoreWorker", {
  queueName: RESCORE_QUEUE_NAME,
  connection: "AzureWebJobsStorage",
  handler: rescoreWorker,
});
