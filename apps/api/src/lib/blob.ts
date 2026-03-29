import {
  BlobServiceClient,
  ContainerClient,
  BlobClient,
  BlockBlobClient,
} from "@azure/storage-blob";

// ─── Client singleton ─────────────────────────────────────────────────────────

let _container: ContainerClient | null = null;

function getContainer(): ContainerClient {
  if (_container) return _container;

  const connectionString = process.env["BLOB_CONNECTION_STRING"];
  const containerName = process.env["BLOB_CONTAINER_NAME"] ?? "data";

  if (!connectionString) {
    throw new Error("BLOB_CONNECTION_STRING environment variable is not set");
  }

  const service = BlobServiceClient.fromConnectionString(connectionString);
  _container = service.getContainerClient(containerName);
  return _container;
}

export function getBlobClient(path: string): BlobClient {
  return getContainer().getBlobClient(path);
}

export function getBlockBlobClient(path: string): BlockBlobClient {
  return getContainer().getBlockBlobClient(path);
}

// ─── Read / Write ─────────────────────────────────────────────────────────────

/**
 * Read a JSON blob. Throws a BlobStorageError with statusCode 404 if the blob
 * does not exist, which callers can use to detect a missing document.
 */
export async function readBlob<T>(blobClient: BlobClient): Promise<T> {
  const response = await blobClient.download();
  const body = await streamToString(response.readableStreamBody!);
  return JSON.parse(body) as T;
}

/**
 * Write a JSON blob, overwriting any existing content.
 * Optionally pass a leaseId to write under an active blob lease.
 */
export async function writeBlob<T>(
  path: string,
  data: T,
  leaseId?: string
): Promise<void> {
  const client = getBlockBlobClient(path);
  const content = JSON.stringify(data, null, 2);
  const options = leaseId
    ? { conditions: { leaseId } }
    : undefined;
  await client.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    conditions: options?.conditions,
  });
}

// ─── withLease ────────────────────────────────────────────────────────────────

/**
 * Acquire a 30-second lease on a blob, execute `fn` with the leaseId, then
 * release the lease. The lease is always released (best-effort) on error.
 */
export async function withLease<T>(
  path: string,
  fn: (leaseId: string) => Promise<T>
): Promise<T> {
  const client = getBlockBlobClient(path);
  const leaseClient = client.getBlobLeaseClient();
  const response = await leaseClient.acquireLease(30);
  const leaseId = response.leaseId;
  if (!leaseId) throw new Error("Failed to acquire blob lease: no leaseId returned");

  try {
    const result = await fn(leaseId);
    await leaseClient.releaseLease();
    return result;
  } catch (err) {
    await leaseClient.releaseLease().catch(() => {
      // best-effort release; ignore errors here
    });
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function streamToString(
  stream: NodeJS.ReadableStream
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
