// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { BlobServiceClient, RestError } from "@azure/storage-blob";

export type AuditCategory = "sign-override";

let privateContainer: ReturnType<BlobServiceClient["getContainerClient"]> | null = null;

export async function appendAuditLine(
  category: AuditCategory,
  payload: object,
): Promise<void> {
  const path = auditPath(category, new Date());
  const client = getPrivateContainer().getAppendBlobClient(path);
  const line = `${JSON.stringify(payload)}\n`;

  try {
    await client.create({
      blobHTTPHeaders: { blobContentType: "application/x-ndjson" },
      conditions: { ifNoneMatch: "*" },
    });
  } catch (err: unknown) {
    if (!isAlreadyExists(err)) throw err;
  }

  await client.appendBlock(line, Buffer.byteLength(line));
}

function auditPath(category: AuditCategory, date: Date): string {
  return `audit/${category}-${date.toISOString().slice(0, 10)}.jsonl`;
}

function getPrivateContainer(): ReturnType<BlobServiceClient["getContainerClient"]> {
  if (privateContainer) return privateContainer;
  const connectionString = process.env["BLOB_CONNECTION_STRING"];
  if (!connectionString) {
    throw new Error("BLOB_CONNECTION_STRING environment variable is not set");
  }
  privateContainer = BlobServiceClient
    .fromConnectionString(connectionString)
    .getContainerClient(process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private");
  return privateContainer;
}

function isAlreadyExists(err: unknown): boolean {
  return err instanceof RestError
    ? err.statusCode === 409
    : (err as { statusCode?: number; code?: string }).statusCode === 409 ||
        (err as { code?: string }).code === "BlobAlreadyExists";
}
