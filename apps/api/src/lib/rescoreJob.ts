// SPDX-License-Identifier: MPL-2.0
import { QueueClient } from "@azure/storage-queue";
import type { RescoreJob, RescoreJobMessage } from "@bccweb/types";

import { getPrivateBlobClient, writePrivateBlob } from "./blob.js";

export const RESCORE_QUEUE_NAME = "rescore-jobs";

const STALE_ACTIVE_GUARD_MS = 12 * 60 * 1000;

export function statusBlobPath(jobId: string): string {
  return `rescore-jobs/${jobId}.json`;
}

export function activeGuardPath(roundId: string): string {
  return `rescore-jobs/active/${roundId}.json`;
}

export async function writeJobStatus(job: RescoreJob): Promise<void> {
  await writePrivateBlob(statusBlobPath(job.jobId), job);
}

export async function readJobStatus(jobId: string): Promise<RescoreJob | null> {
  try {
    const response = await getPrivateBlobClient(statusBlobPath(jobId)).download();
    const body = await streamToString(response.readableStreamBody);
    const parsed = JSON.parse(body) as RescoreJob;
    return parsed;
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) return null;
    throw err;
  }
}

export async function acquireActiveGuard(roundId: string): Promise<boolean> {
  const path = activeGuardPath(roundId);
  const client = getPrivateBlobClient(path);

  try {
    await writePrivateBlob(path, {}, undefined, { ifNoneMatch: "*" });
    return true;
  } catch (err: unknown) {
    if (!isConflict(err)) throw err;
  }

  const properties = await client.getProperties();
  const lastModified = properties.lastModified?.getTime();
  const ageMs = lastModified === undefined ? 0 : Date.now() - lastModified;
  if (!Number.isFinite(ageMs) || ageMs <= STALE_ACTIVE_GUARD_MS) return false;

  await client.deleteIfExists();

  try {
    await writePrivateBlob(path, {}, undefined, { ifNoneMatch: "*" });
    return true;
  } catch (err: unknown) {
    if (isConflict(err)) return false;
    throw err;
  }
}

export async function releaseActiveGuard(roundId: string): Promise<void> {
  await getPrivateBlobClient(activeGuardPath(roundId)).deleteIfExists();
}

export async function enqueueRescore(msg: RescoreJobMessage): Promise<void> {
  const client = new QueueClient(queueConnectionString(), RESCORE_QUEUE_NAME);
  await client.createIfNotExists();
  await client.sendMessage(Buffer.from(JSON.stringify(msg)).toString("base64"));
}

function queueConnectionString(): string {
  const connectionString =
    process.env["AzureWebJobsStorage"] ?? process.env["BLOB_CONNECTION_STRING"];
  if (!connectionString) {
    throw new Error(
      "AzureWebJobsStorage environment variable is not set (required to enqueue rescore jobs)",
    );
  }
  return connectionString;
}

function statusCodeOf(err: unknown): number | undefined {
  return err instanceof Object && "statusCode" in err
    ? Number(err.statusCode)
    : undefined;
}

function isConflict(err: unknown): boolean {
  const statusCode = statusCodeOf(err);
  return statusCode === 409 || statusCode === 412;
}

async function streamToString(
  stream: NodeJS.ReadableStream | undefined,
): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
