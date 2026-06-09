import {
  BlobServiceClient,
  ContainerClient,
  BlobClient,
  BlockBlobClient,
} from "@azure/storage-blob";

// ─── Client singletons ────────────────────────────────────────────────────────

let _container: ContainerClient | null = null;
let _privateContainer: ContainerClient | null = null;
let _blobService: BlobServiceClient | null = null;

interface LeaseRenewingOptions {
  leaseDurationSec?: number;
  renewIntervalMs?: number;
}

export class LeaseRenewalFailedError extends Error {
  readonly cause: unknown;

  constructor(path: string, cause: unknown) {
    super(`Blob lease renewal failed for ${path}`);
    this.name = "LeaseRenewalFailedError";
    this.cause = cause;
  }
}

function getBlobService(): BlobServiceClient {
  if (_blobService) return _blobService;
  const connectionString = process.env["BLOB_CONNECTION_STRING"];
  if (!connectionString) {
    throw new Error("BLOB_CONNECTION_STRING environment variable is not set");
  }
  _blobService = BlobServiceClient.fromConnectionString(connectionString);
  return _blobService;
}

function getContainer(): ContainerClient {
  if (_container) return _container;
  const containerName = process.env["BLOB_CONTAINER_NAME"] ?? "data";
  _container = getBlobService().getContainerClient(containerName);
  return _container;
}

function getPrivateContainer(): ContainerClient {
  if (_privateContainer) return _privateContainer;
  const containerName = process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private";
  _privateContainer = getBlobService().getContainerClient(containerName);
  return _privateContainer;
}

// ─── Public container accessors ──────────────────────────────────────────────

export function getBlobClient(path: string): BlobClient {
  return getContainer().getBlobClient(path);
}

export function getBlockBlobClient(path: string): BlockBlobClient {
  return getContainer().getBlockBlobClient(path);
}

// ─── Private container accessors ─────────────────────────────────────────────

export function getPrivateBlobClient(path: string): BlobClient {
  return getPrivateContainer().getBlobClient(path);
}

export function getPrivateBlockBlobClient(path: string): BlockBlobClient {
  return getPrivateContainer().getBlockBlobClient(path);
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
 * Write a JSON blob to the public container, overwriting any existing content.
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

/**
 * Write a JSON blob to the private container, overwriting any existing content.
 * Optionally pass a leaseId to write under an active blob lease.
 *
 * Pass `options.ifNoneMatch = "*"` to perform an atomic create-only write —
 * Azure returns HTTP 412 (PreconditionFailed) if the blob already exists, which
 * the caller can catch and treat as a no-op (don't overwrite).
 */
export async function writePrivateBlob<T>(
  path: string,
  data: T,
  leaseId?: string,
  options?: { ifNoneMatch?: string }
): Promise<void> {
  const client = getPrivateBlockBlobClient(path);
  const content = JSON.stringify(data, null, 2);
  const conditions: { leaseId?: string; ifNoneMatch?: string } = {};
  if (leaseId) conditions.leaseId = leaseId;
  if (options?.ifNoneMatch) conditions.ifNoneMatch = options.ifNoneMatch;
  await client.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
  });
}

// ─── withLease ────────────────────────────────────────────────────────────────

/**
 * Acquire a 30-second lease on a public blob, execute `fn` with the leaseId,
 * then release the lease. The lease is always released (best-effort) on error.
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

/**
 * Acquire a 30-second lease on a private blob, execute `fn` with the leaseId,
 * then release the lease. The lease is always released (best-effort) on error.
 */
export async function withPrivateLease<T>(
  path: string,
  fn: (leaseId: string) => Promise<T>
): Promise<T> {
  const client = getPrivateBlockBlobClient(path);
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

// ─── withLeaseRenewing ────────────────────────────────────────────────────────

/**
 * Acquire a renewable lease on a public blob. A background interval renews the
 * lease while `fn` runs, then the lease is released best-effort in all cases.
 */
export async function withLeaseRenewing<T>(
  path: string,
  fn: (leaseId: string) => Promise<T>,
  opts: LeaseRenewingOptions = {}
): Promise<T> {
  return withLeaseRenewingOnClient(path, getBlockBlobClient(path), fn, opts);
}

/**
 * Acquire a renewable lease on a private blob. A background interval renews the
 * lease while `fn` runs, then the lease is released best-effort in all cases.
 */
export async function withPrivateLeaseRenewing<T>(
  path: string,
  fn: (leaseId: string) => Promise<T>,
  opts: LeaseRenewingOptions = {}
): Promise<T> {
  return withLeaseRenewingOnClient(path, getPrivateBlockBlobClient(path), fn, opts);
}

async function withLeaseRenewingOnClient<T>(
  path: string,
  client: BlockBlobClient,
  fn: (leaseId: string) => Promise<T>,
  opts: LeaseRenewingOptions
): Promise<T> {
  const leaseDurationSec = opts.leaseDurationSec ?? 30;
  const renewIntervalMs = opts.renewIntervalMs ?? 15_000;

  if (renewIntervalMs > leaseDurationSec * 500) {
    throw new Error("renewal interval too long");
  }

  const leaseClient = client.getBlobLeaseClient();
  const response = await leaseClient.acquireLease(leaseDurationSec);
  const leaseId = response.leaseId;
  if (!leaseId) throw new Error("Failed to acquire blob lease: no leaseId returned");

  console.log("[lease] acquired", { path, leaseId });

  let attempt = 0;
  let totalRenewals = 0;
  let renewalError: unknown = null;
  const handle = setInterval(async () => {
    attempt += 1;
    try {
      await leaseClient.renewLease();
      totalRenewals += 1;
      console.log("[lease] renewed", { path, leaseId, attempt });
    } catch (err) {
      renewalError = err;
      clearInterval(handle);
    }
  }, renewIntervalMs);

  let fnError: unknown = null;
  try {
    return await fn(leaseId);
  } catch (err) {
    fnError = err;
    throw err;
  } finally {
    clearInterval(handle);
    await leaseClient.releaseLease().catch(() => {
      // best-effort release; ignore errors here
    });
    console.log("[lease] released", { path, leaseId, totalRenewals });
    if (renewalError && !fnError) {
      throw new LeaseRenewalFailedError(path, renewalError);
    }
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
