import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ─── Mock @azure/storage-blob ────────────────────────────────────────────────
// blob.ts resolves a BlockBlobClient through:
//   BlobServiceClient.fromConnectionString() → getContainerClient() →
//   getBlockBlobClient(). We stub that whole chain down to a single shared
//   `uploadData` mock so each test can drive create / 409 / 412 outcomes and
//   assert the exact seed + ifNoneMatch:"*" condition passed on the create.
const { uploadData, fromConnectionString } = vi.hoisted(() => {
  const uploadData = vi.fn();
  const blockBlobClient = { uploadData };
  const containerClient = {
    getBlobClient: vi.fn(),
    getBlockBlobClient: vi.fn(() => blockBlobClient),
  };
  return {
    uploadData,
    fromConnectionString: vi.fn(() => ({
      getContainerClient: vi.fn(() => containerClient),
    })),
  };
});

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: { fromConnectionString },
}));

// Contract tests for the shipped index-creation helpers in blob.ts.
// Every call below targets the exported helpers directly.
async function loadHelpers() {
  return import("../blob.js");
}

describe("ensureJsonIndexBlob / ensurePrivateJsonIndexBlob — create-only contract", () => {
  beforeEach(() => {
    vi.resetModules();
    uploadData.mockReset();
    fromConnectionString.mockClear();
    process.env["BLOB_CONNECTION_STRING"] = "UseDevelopmentStorage=true";
    process.env["BLOB_CONTAINER_NAME"] = "data";
    process.env["BLOB_PRIVATE_CONTAINER_NAME"] = "data-private";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env["BLOB_CONNECTION_STRING"];
    delete process.env["BLOB_CONTAINER_NAME"];
    delete process.env["BLOB_PRIVATE_CONTAINER_NAME"];
  });

  // ── 1. blob absent → create with ifNoneMatch:"*" and the json-array seed ───
  test("absent → uploads seed '[]' with ifNoneMatch:'*' (create-only)", async () => {
    uploadData.mockResolvedValueOnce(undefined);
    const { ensureJsonIndexBlob } = await loadHelpers();

    await ensureJsonIndexBlob("pilots.json", "[]");

    expect(uploadData).toHaveBeenCalledTimes(1);
    const [body, options] = uploadData.mock.calls[0];
    expect(Buffer.isBuffer(body)).toBe(true);
    expect((body as Buffer).toString()).toBe("[]");
    expect(options).toMatchObject({
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { ifNoneMatch: "*" },
    });
  });

  // ── 2. 409 → return immediately, NO retry (already exists) ─────────────────
  // KEY divergence from the 20-attempt lease family: on 409 the create-only
  // helper treats the blob as already-present and resolves WITHOUT retrying.
  test("409 → resolves immediately with no retry (no-op)", async () => {
    uploadData.mockRejectedValueOnce({ statusCode: 409 });
    const { ensureJsonIndexBlob } = await loadHelpers();

    await expect(
      ensureJsonIndexBlob("pilots.json", "[]"),
    ).resolves.toBeUndefined();

    // Exactly one attempt — a 409 MUST NOT trigger the retry loop.
    expect(uploadData).toHaveBeenCalledTimes(1);
  });

  // ── 3. 412 → retry up to 10 attempts with 25*attempt backoff ──────────────
  test("412 → retries with 25*attempt backoff then succeeds", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    uploadData
      .mockRejectedValueOnce({ statusCode: 412 })
      .mockRejectedValueOnce({ statusCode: 412 })
      .mockResolvedValueOnce(undefined);

    const { ensureJsonIndexBlob } = await loadHelpers();
    const pending = ensureJsonIndexBlob("pilots.json", "[]");
    await vi.runAllTimersAsync();
    await pending;

    expect(uploadData).toHaveBeenCalledTimes(3);
    // Backoff schedule: attempt 1 → 25ms, attempt 2 → 50ms.
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 25);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 50);
  });

  // ── 4. 412 ×10 (exhaust) → throw the ORIGINAL error ───────────────────────
  test("412 ×10 exhausts attempts and throws the original error", async () => {
    vi.useFakeTimers();
    const original = { statusCode: 412, message: "PreconditionFailed" };
    uploadData.mockRejectedValue(original);

    const { ensureJsonIndexBlob } = await loadHelpers();
    const pending = ensureJsonIndexBlob("pilots.json", "[]");
    const caught = pending.then(
      () => {
        throw new Error("expected rejection");
      },
      (err: unknown) => err,
    );
    await vi.runAllTimersAsync();

    expect(await caught).toBe(original);
    expect(uploadData).toHaveBeenCalledTimes(10);
  });

  // ── 5. private helper seeds '{}' (record index), distinct from '[]' ───────
  test("ensurePrivateJsonIndexBlob → uploads seed '{}' with ifNoneMatch:'*'", async () => {
    uploadData.mockResolvedValueOnce(undefined);
    const { ensurePrivateJsonIndexBlob } = await loadHelpers();

    await ensurePrivateJsonIndexBlob("user-index.json", "{}");

    expect(uploadData).toHaveBeenCalledTimes(1);
    const [body, options] = uploadData.mock.calls[0];
    expect(Buffer.isBuffer(body)).toBe(true);
    expect((body as Buffer).toString()).toBe("{}");
    expect(options).toMatchObject({
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { ifNoneMatch: "*" },
    });
  });

  // ── 5b. private helper also honours 409→no-op (no retry) ──────────────────
  test("ensurePrivateJsonIndexBlob → 409 resolves immediately, no retry", async () => {
    uploadData.mockRejectedValueOnce({ statusCode: 409 });
    const { ensurePrivateJsonIndexBlob } = await loadHelpers();

    await expect(
      ensurePrivateJsonIndexBlob("user-index.json", "{}"),
    ).resolves.toBeUndefined();
    expect(uploadData).toHaveBeenCalledTimes(1);
  });
});
