/**
 * Azurite lifecycle for API integration tests.
 *
 * - beforeAll: create both containers ("data", "data-private") in Azurite
 *
 * Requires Azurite running locally (docker-compose up azurite).
 * Uses BLOB_CONNECTION_STRING defaulting to the Azurite dev connection string.
 *
 * No afterEach cleanup — each test creates unique data (randomUUID) so tests
 * don't collide. Clearing blobs between tests is unsafe because Vitest
 * workspace mode runs test files concurrently, and one file's afterEach would
 * delete blobs that another file's tests depend on mid-execution.
 */

import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { beforeAll } from "vitest";

// Azurite well-known development connection string
const AZURITE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

export const CONNECTION_STRING =
  process.env["BLOB_CONNECTION_STRING"] ?? AZURITE_CONNECTION_STRING;

export const PUBLIC_CONTAINER = "data";
export const PRIVATE_CONTAINER = "data-private";

let blobService: BlobServiceClient;
let publicContainer: ContainerClient;
let privateContainer: ContainerClient;

export function getBlobService(): BlobServiceClient {
  return blobService;
}

export function getPublicContainer(): ContainerClient {
  return publicContainer;
}

export function getPrivateContainer(): ContainerClient {
  return privateContainer;
}

// ─── Lifecycle hooks ─────────────────────────────────────────────────────────

beforeAll(async () => {
  blobService = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
  publicContainer = blobService.getContainerClient(PUBLIC_CONTAINER);
  privateContainer = blobService.getContainerClient(PRIVATE_CONTAINER);

  // Create containers idempotently
  await publicContainer.createIfNotExists({ access: "blob" });
  await privateContainer.createIfNotExists();
});
