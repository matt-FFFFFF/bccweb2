import {
  BlobServiceClient,
  ContainerClient,
  BlobClient,
  BlockBlobClient,
} from "@azure/storage-blob";
import { getTelemetryClient } from "./telemetry.js";

// ─── Client singletons ────────────────────────────────────────────────────────

let _container: ContainerClient | null = null;
let _privateContainer: ContainerClient | null = null;
let _blobService: BlobServiceClient | null = null;

// TEST-ONLY: clears module-level container/service caches so the next access re-reads BLOB_CONNECTION_STRING / BLOB_CONTAINER_NAME / BLOB_PRIVATE_CONTAINER_NAME from env. Used by helpers/azurite.ts beforeAll to make per-file test container isolation pool-config-proof.
export function resetBlobSingletons(): void {
  _container = null;
  _privateContainer = null;
  _blobService = null;
}

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
  const containerName = process.env["BLOB_CONTAINER_NAME"];
  if (!containerName) {
    throw new Error("BLOB_CONTAINER_NAME environment variable is not set");
  }
  _container = getBlobService().getContainerClient(containerName);
  return _container;
}

function getPrivateContainer(): ContainerClient {
  if (_privateContainer) return _privateContainer;
  const containerName = process.env["BLOB_PRIVATE_CONTAINER_NAME"];
  if (!containerName) {
    throw new Error("BLOB_PRIVATE_CONTAINER_NAME environment variable is not set");
  }
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
 * PREFER readJson() — raw read for non-JSON content only.
 *
 * Read a JSON blob. Throws a BlobStorageError with statusCode 404 if the blob
 * does not exist, which callers can use to detect a missing document.
 */
export async function readBlob(blobClient: BlobClient): Promise<unknown> {
  const response = await blobClient.download();
  const body = await streamToString(response.readableStreamBody!);
  return JSON.parse(body);
}

/**
 * PREFER readJson() — raw read for non-JSON content only.
 *
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
 * PREFER readJson() — raw read for non-JSON content only.
 *
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

export async function ensureJsonIndexBlob(
  path: string,
  seed: string
): Promise<void> {
  const client = getBlockBlobClient(path);
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await client.uploadData(Buffer.from(seed), {
        blobHTTPHeaders: { blobContentType: "application/json" },
        conditions: { ifNoneMatch: "*" },
      });
      return;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 409) return;
      if (statusCode !== 412 || attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }
}

export async function ensurePrivateJsonIndexBlob(
  path: string,
  seed: string
): Promise<void> {
  const client = getPrivateBlockBlobClient(path);
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await client.uploadData(Buffer.from(seed), {
        blobHTTPHeaders: { blobContentType: "application/json" },
        conditions: { ifNoneMatch: "*" },
      });
      return;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 409) return;
      if (statusCode !== 412 || attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }
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
  return withLeaseOnClient(path, getBlockBlobClient(path), fn);
}

/**
 * Acquire a 30-second lease on a private blob, execute `fn` with the leaseId,
 * then release the lease. The lease is always released (best-effort) on error.
 */
export async function withPrivateLease<T>(
  path: string,
  fn: (leaseId: string) => Promise<T>
): Promise<T> {
  return withLeaseOnClient(path, getPrivateBlockBlobClient(path), fn);
}

export async function withLeaseRetry(
  path: string,
  fn: (leaseId: string) => Promise<unknown>
): Promise<void> {
  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await withLease(path, fn);
      return;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode !== 409 && statusCode !== 412) throw err;
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }
}

export async function withPrivateLeaseRetry<T>(
  path: string,
  fn: (leaseId: string) => Promise<T>
): Promise<T> {
  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withPrivateLease(path, fn);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode !== 409 && statusCode !== 412) throw err;
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }
  throw new Error("Failed to acquire private blob lease");
}

async function withLeaseOnClient<T>(
  path: string,
  client: BlockBlobClient,
  fn: (leaseId: string) => Promise<T>
): Promise<T> {
  const leaseClient = client.getBlobLeaseClient();
  const response = await leaseClient.acquireLease(30);
  const leaseId = response.leaseId;
  if (!leaseId)
    throw new Error(
      `Failed to acquire blob lease for "${path}": no leaseId returned`
    );

  try {
    return await fn(leaseId);
  } finally {
    await leaseClient.releaseLease().catch(() => {
      // best-effort release; ignore errors here
    });
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
  if (!leaseId)
    throw new Error(
      `Failed to acquire blob lease for "${path}": no leaseId returned`
    );

  trackLeaseTrace("Blob lease acquired", { path, leaseId });

  let attempt = 0;
  let totalRenewals = 0;
  let renewalError: unknown = null;
  let renewing = false;
  const handle = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    attempt += 1;
    try {
      await leaseClient.renewLease();
      totalRenewals += 1;
      trackLeaseTrace("Blob lease renewed", {
        path,
        leaseId,
        attempt,
      });
    } catch (err) {
      renewalError = err;
      clearInterval(handle);
    } finally {
      renewing = false;
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
    trackLeaseTrace("Blob lease released", {
      path,
      leaseId,
      totalRenewals,
    });
    if (renewalError && !fnError) {
      throw new LeaseRenewalFailedError(path, renewalError);
    }
  }
}

function trackLeaseTrace(
  message: string,
  properties: Record<string, unknown>
): void {
  const client = getTelemetryClient();
  client?.trackTrace({ message, properties });
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
