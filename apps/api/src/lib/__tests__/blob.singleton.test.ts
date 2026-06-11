import { afterEach, describe, expect, test, vi } from "vitest";

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

import { getBlobClient, resetBlobSingletons } from "../blob.js";

describe("resetBlobSingletons", () => {
  afterEach(() => {
    resetBlobSingletons();
    delete process.env.BLOB_CONNECTION_STRING;
    delete process.env.BLOB_CONTAINER_NAME;
  });

  test("re-reads BLOB_CONNECTION_STRING after reset", () => {
    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true;first";
    process.env.BLOB_CONTAINER_NAME = "data";

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
