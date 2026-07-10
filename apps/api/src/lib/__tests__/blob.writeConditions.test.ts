// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getPublicContainer } from "../../__tests__/helpers/azurite.js";
import { writeBlob } from "../blob.js";

async function readPublicBlob(path: string): Promise<string> {
  const content = await getPublicContainer()
    .getBlobClient(path)
    .downloadToBuffer();
  return content.toString();
}

function expectWriteConflict(err: unknown): void {
  expect([409, 412]).toContain((err as { statusCode?: number }).statusCode);
}

describe("writeBlob write conditions (real Azurite)", () => {
  test("create-only without a lease writes a fresh blob", async () => {
    const path = `write-conditions/${randomUUID()}.json`;

    await writeBlob(path, { v: 1 }, undefined, { ifNoneMatch: "*" });

    await expect(readPublicBlob(path)).resolves.toBe(
      JSON.stringify({ v: 1 }, null, 2),
    );
  });

  test("create-only rejects when the public blob already exists", async () => {
    const path = `write-conditions/${randomUUID()}.json`;
    await writeBlob(path, { v: 1 }, undefined, { ifNoneMatch: "*" });

    try {
      await writeBlob(path, { v: 2 }, undefined, { ifNoneMatch: "*" });
      throw new Error("expected create-only conflict");
    } catch (err) {
      expectWriteConflict(err);
    }
  });

  test("plain overwrite keeps the existing JSON bytes", async () => {
    const path = `write-conditions/${randomUUID()}.json`;
    await writeBlob(path, { v: 1 });

    await writeBlob(path, { v: 3 });

    await expect(readPublicBlob(path)).resolves.toBe(
      JSON.stringify({ v: 3 }, null, 2),
    );
  });

  test("leaseId-only writes under an active public blob lease", async () => {
    const path = `write-conditions/${randomUUID()}.json`;
    await writeBlob(path, { v: 0 });
    const leaseClient = getPublicContainer()
      .getBlobClient(path)
      .getBlobLeaseClient();
    const lease = await leaseClient.acquireLease(30);

    try {
      await writeBlob(path, { v: 4 }, lease.leaseId);
    } finally {
      await leaseClient.releaseLease();
    }

    await expect(readPublicBlob(path)).resolves.toBe(
      JSON.stringify({ v: 4 }, null, 2),
    );
  });

  test("stale leaseId rejects while the public blob is leased out-of-band", async () => {
    const path = `write-conditions/${randomUUID()}.json`;
    await writeBlob(path, { v: 0 });
    const leaseClient = getPublicContainer()
      .getBlobClient(path)
      .getBlobLeaseClient();
    await leaseClient.acquireLease(30);

    try {
      await expect(writeBlob(path, { v: 5 }, "wrong-lease-id")).rejects
        .toSatisfy((err: unknown) => {
          expectWriteConflict(err);
          return true;
        });
    } finally {
      await leaseClient.releaseLease();
    }
  });
});

function makeStorageMock(upload: ReturnType<typeof vi.fn>) {
  const blockBlobClient = { upload };
  const containerClient = {
    getBlobClient: () => blockBlobClient,
    getBlockBlobClient: () => blockBlobClient,
  };
  const service = { getContainerClient: () => containerClient };
  return {
    BlobServiceClient: { fromConnectionString: () => service },
  };
}

async function importBlobWithMockedUpload(upload: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock("@azure/storage-blob", () => makeStorageMock(upload));
  return import("../blob.js");
}

describe("writeBlob write conditions (mocked threading)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@azure/storage-blob");
    vi.resetModules();
  });

  test("threads both leaseId and ifNoneMatch to the public upload conditions", async () => {
    const upload = vi.fn().mockResolvedValue(undefined);
    const { writeBlob: writeBlobWithMock } = await importBlobWithMockedUpload(
      upload,
    );

    await writeBlobWithMock("p", { v: 6 }, "lease-1", { ifNoneMatch: "*" });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[2]).toMatchObject({
      conditions: { leaseId: "lease-1", ifNoneMatch: "*" },
    });
  });
});
