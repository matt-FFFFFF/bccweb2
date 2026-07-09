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
    // Restore any spies (e.g. the globalThis.setTimeout spies below) so they
    // never leak across tests and cause cross-file flakiness.
    vi.restoreAllMocks();
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
  // KEY divergence from the retrying lease family: on 409 the create-only
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

  // ── 3. 412 → resolves immediately as no-op, NO retry/backoff ──────────────
  // NEW contract: real Azure returns 409 for create-only on an existing blob,
  // but a 412 PreconditionFailed is likewise treated as "already present" —
  // resolve at once, exactly one uploadData call, and NEVER schedule a retry
  // (setTimeout must not fire).
  test("412 → resolves immediately, exactly 1 call, setTimeout not called", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    uploadData.mockRejectedValueOnce({ statusCode: 412 });

    const { ensureJsonIndexBlob } = await loadHelpers();

    await expect(
      ensureJsonIndexBlob("pilots.json", "[]"),
    ).resolves.toBeUndefined();

    // No retry loop: one attempt only and no backoff scheduled.
    expect(uploadData).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  // ── 3b. private helper also treats 412 as a no-op (no retry) ──────────────
  test("ensurePrivateJsonIndexBlob → 412 resolves immediately, exactly 1 call, setTimeout not called", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    uploadData.mockRejectedValueOnce({ statusCode: 412 });

    const { ensurePrivateJsonIndexBlob } = await loadHelpers();

    await expect(
      ensurePrivateJsonIndexBlob("user-index.json", "{}"),
    ).resolves.toBeUndefined();

    expect(uploadData).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  // ── 4. non-409/412 (500) → reject with that exact error, exactly 1 call ───
  // Guard: the helper MUST NOT swallow unexpected failures. A 500 propagates
  // unchanged on the first attempt — no retry.
  test("non-409/412 (statusCode 500) → rejects with that exact error, exactly 1 call", async () => {
    const boom = { statusCode: 500, message: "InternalError" };
    uploadData.mockRejectedValueOnce(boom);

    const { ensureJsonIndexBlob } = await loadHelpers();

    await expect(ensureJsonIndexBlob("pilots.json", "[]")).rejects.toBe(boom);
    expect(uploadData).toHaveBeenCalledTimes(1);
  });

  // ── 4b. private helper also propagates a non-409/412 error ────────────────
  test("ensurePrivateJsonIndexBlob → non-409/412 (statusCode 500) rejects with that exact error, exactly 1 call", async () => {
    const boom = { statusCode: 500, message: "InternalError" };
    uploadData.mockRejectedValueOnce(boom);

    const { ensurePrivateJsonIndexBlob } = await loadHelpers();

    await expect(
      ensurePrivateJsonIndexBlob("user-index.json", "{}"),
    ).rejects.toBe(boom);
    expect(uploadData).toHaveBeenCalledTimes(1);
  });

  // ── 4c. error with NO statusCode → reject with that error, exactly 1 call ─
  // e.g. a DNS/network failure carries no statusCode; it must still propagate.
  test("error with no statusCode → rejects with that exact error, exactly 1 call", async () => {
    const netErr = new Error("ENOTFOUND");
    uploadData.mockRejectedValueOnce(netErr);

    const { ensureJsonIndexBlob } = await loadHelpers();

    await expect(ensureJsonIndexBlob("pilots.json", "[]")).rejects.toBe(netErr);
    expect(uploadData).toHaveBeenCalledTimes(1);
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
