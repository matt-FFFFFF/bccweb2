import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { fromConnectionString } = vi.hoisted(() => ({
  fromConnectionString: vi.fn((connectionString: string) => ({
    connectionString,
    getContainerClient: vi.fn((containerName: string) => ({
      connectionString,
      containerName,
      getBlobClient: vi.fn(),
      getBlockBlobClient: vi.fn(),
    })),
  })),
}));

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString,
  },
}));

describe("resetBlobSingletons", () => {
  beforeEach(() => {
    // Reset the module registry so the dynamic import below re-loads blob.js
    // with the mocked @azure/storage-blob in place. Without this, blob.js is
    // cached from earlier setup-file imports and still references the real
    // package — making the mock invisible.
    vi.resetModules();
    fromConnectionString.mockClear();
  });

  afterEach(() => {
    delete process.env.BLOB_CONNECTION_STRING;
    delete process.env.BLOB_CONTAINER_NAME;
  });

  test("re-reads BLOB_CONNECTION_STRING after reset", async () => {
    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true;first";
    process.env.BLOB_CONTAINER_NAME = "data";

    const { getBlobClient, resetBlobSingletons } = await import("../blob.js");

    getBlobClient("rounds/one.json");
    expect(fromConnectionString).toHaveBeenCalledTimes(1);
    expect(fromConnectionString).toHaveBeenCalledWith(
      "UseDevelopmentStorage=true;first"
    );

    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true;second";
    getBlobClient("rounds/two.json");
    expect(fromConnectionString).toHaveBeenCalledTimes(1);

    resetBlobSingletons();
    getBlobClient("rounds/three.json");
    expect(fromConnectionString).toHaveBeenCalledTimes(2);
    expect(fromConnectionString).toHaveBeenLastCalledWith(
      "UseDevelopmentStorage=true;second"
    );
  });
});
