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
  writeJobStatus,
} from "../lib/rescoreJob.js";
import { runRescoreJob } from "./rescoreRound.js";

function parseRescoreMessage(message: unknown): RescoreJobMessage | null {
  const raw: unknown = typeof message === "string" ? JSON.parse(message) : message;
  if (raw === null || typeof raw !== "object") return null;

  const candidate = raw as Partial<RescoreJobMessage>;
  if (typeof candidate.jobId !== "string" || candidate.jobId.trim() === "") {
    return null;
  }
  if (typeof candidate.roundId !== "string" || candidate.roundId.trim() === "") {
    return null;
  }

  return {
    jobId: candidate.jobId,
    roundId: candidate.roundId,
    requestedByEmail: typeof candidate.requestedByEmail === "string"
      ? candidate.requestedByEmail
      : "",
    requestedByIp: typeof candidate.requestedByIp === "string"
      ? candidate.requestedByIp
      : "",
    requestedAt: typeof candidate.requestedAt === "string"
      ? candidate.requestedAt
      : "",
  };
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
    const year = await readRoundSeasonYear(msg.roundId);
    recomputeSeason(year).catch((err: unknown) => {
      ctx.error(`[rescoreWorker] recomputeSeason(${year}) failed:`, err);
    });
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
