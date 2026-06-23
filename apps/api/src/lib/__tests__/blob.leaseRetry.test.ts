/**
 * Contract test for the exported lease-retry helpers
 *   withLeaseRetry(path, fn)        → wraps withLease
 *   withPrivateLeaseRetry(path, fn) → wraps withPrivateLease
 * in apps/api/src/lib/blob.ts.
 *
 * This encodes the EXACT current semantics of the 20-attempt retry copied in
 *   apps/api/src/functions/pilots.ts:395-411 (withLeaseRetry, public)
 *   apps/api/src/lib/auth.ts:162-178       (withPrivateLeaseRetry, private)
 *   apps/api/src/functions/meProfile.ts:235-251 (byte-identical copy)
 *
 * Contract (both helpers):
 *   - maxAttempts = 20
 *   - on caught error: if statusCode is NOT 409 and NOT 412 → rethrow immediately
 *   - if statusCode IS 409 || 412: retry, unless this was attempt === maxAttempts,
 *     in which case rethrow the ORIGINAL error (identity + statusCode preserved)
 *   - backoff between retries = 25 * attempt milliseconds
 *
 * LIGHT suite: the lease layer is mocked at the @azure/storage-blob seam, so
 * 409/412 sequences are injected WITHOUT Azurite and WITHOUT real wall-clock
 * waits (vi.useFakeTimers drives the backoff).
 *
 * This file exercises the shipped exports directly.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ─── Controllable lease-client mock (the injection seam) ─────────────────────
//
// blob.ts builds its clients from BlobServiceClient.fromConnectionString(...).
// We replace that so getBlockBlobClient/getPrivateBlockBlobClient ultimately
// hand back a lease client whose acquireLease/releaseLease we control. withLease
// /withPrivateLease call acquireLease(30) OUTSIDE their try block, so a rejected
// acquireLease propagates the error unchanged (same identity, statusCode intact)
// straight to the retry wrapper.
const azureMock = vi.hoisted(() => {
  const acquireLease = vi.fn();
  const releaseLease = vi.fn().mockResolvedValue(undefined);
  const leaseClient = { acquireLease, releaseLease };
  const blockBlobClient = { getBlobLeaseClient: () => leaseClient };
  const containerClient = {
    getBlobClient: () => ({}),
    getBlockBlobClient: () => blockBlobClient,
  };
  const fromConnectionString = vi.fn(() => ({
    getContainerClient: () => containerClient,
  }));
  return { acquireLease, releaseLease, fromConnectionString };
});

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: { fromConnectionString: azureMock.fromConnectionString },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function leaseError(statusCode: number): Error & { statusCode: number } {
  const err = new Error(`lease conflict (statusCode ${statusCode})`) as Error & {
    statusCode: number;
  };
  err.statusCode = statusCode;
  return err;
}

/** Program acquireLease to reject with each code in order, then resolve. */
function failThenSucceed(codes: number[], leaseId = "lease-test"): void {
  azureMock.acquireLease.mockReset();
  for (const code of codes) {
    azureMock.acquireLease.mockRejectedValueOnce(leaseError(code));
  }
  azureMock.acquireLease.mockResolvedValue({ leaseId });
}

/** Dynamically import the (post-reset) blob module with the azure mock in place. */
async function importBlob(): Promise<typeof import("../blob.js")> {
  return import("../blob.js");
}

beforeEach(() => {
  // Re-load blob.js against the mocked @azure/storage-blob (it is cached with
  // the real package from the shared setup files otherwise — see
  // blob.singleton.test.ts for the same dance).
  vi.resetModules();
  azureMock.acquireLease.mockReset();
  azureMock.releaseLease.mockReset();
  azureMock.releaseLease.mockResolvedValue(undefined);
  azureMock.fromConnectionString.mockClear();
  // Fake timers so the `setTimeout(resolve, 25 * attempt)` backoff never sleeps.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Case 1: 409 then success → retries and resolves with fn's result ────────

describe("withLeaseRetry / withPrivateLeaseRetry — 20-attempt contract", () => {
  test("409 then success → retries once and resolves (public)", async () => {
    failThenSucceed([409]);
    const { withLeaseRetry } = await importBlob();

    const fn = vi.fn().mockResolvedValue(undefined);
    const promise = withLeaseRetry("rounds.json", fn);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeUndefined();
    expect(azureMock.acquireLease).toHaveBeenCalledTimes(2); // 1 fail + 1 ok
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("lease-test");
  });

  test("409 then success → resolves WITH fn's result (private returns T)", async () => {
    failThenSucceed([409]);
    const { withPrivateLeaseRetry } = await importBlob();

    const sentinel = { ok: true, value: 42 };
    const fn = vi.fn().mockResolvedValue(sentinel);
    const promise = withPrivateLeaseRetry("user-index.json", fn);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe(sentinel);
    expect(azureMock.acquireLease).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ─── Case 2: 412 then success → retries and resolves ───────────────────────

  test("412 then success → retries once and resolves (public)", async () => {
    failThenSucceed([412]);
    const { withLeaseRetry } = await importBlob();

    const fn = vi.fn().mockResolvedValue(undefined);
    const promise = withLeaseRetry("rounds.json", fn);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeUndefined();
    expect(azureMock.acquireLease).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("412 then success → retries once and resolves (private)", async () => {
    failThenSucceed([412]);
    const { withPrivateLeaseRetry } = await importBlob();

    const sentinel = { saved: "yes" };
    const fn = vi.fn().mockResolvedValue(sentinel);
    const promise = withPrivateLeaseRetry("user-index.json", fn);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe(sentinel);
    expect(azureMock.acquireLease).toHaveBeenCalledTimes(2);
  });

  // ─── Case 3: non-409/412 error → throws immediately (no retry) ─────────────

  test("non-409/412 error → throws immediately, no retry (public)", async () => {
    const fatal = leaseError(500);
    azureMock.acquireLease.mockReset();
    azureMock.acquireLease.mockRejectedValue(fatal);
    const { withLeaseRetry } = await importBlob();

    const fn = vi.fn().mockResolvedValue(undefined);
    const assertion = expect(withLeaseRetry("rounds.json", fn)).rejects.toBe(fatal);
    await vi.runAllTimersAsync();

    await assertion;
    expect(azureMock.acquireLease).toHaveBeenCalledTimes(1); // no retry
    expect(fn).not.toHaveBeenCalled();
  });

  test("non-409/412 error → throws immediately, no retry (private)", async () => {
    const fatal = leaseError(404);
    azureMock.acquireLease.mockReset();
    azureMock.acquireLease.mockRejectedValue(fatal);
    const { withPrivateLeaseRetry } = await importBlob();

    const fn = vi.fn().mockResolvedValue("never");
    const assertion = expect(withPrivateLeaseRetry("user-index.json", fn)).rejects.toBe(
      fatal
    );
    await vi.runAllTimersAsync();

    await assertion;
    expect(azureMock.acquireLease).toHaveBeenCalledTimes(1);
  });

  // ─── Case 4: 20 consecutive 409s → throws ORIGINAL error, exactly 20 tries ─

  test("20 consecutive 409s → throws original error after exactly maxAttempts (public)", async () => {
    const conflict = leaseError(409);
    azureMock.acquireLease.mockReset();
    azureMock.acquireLease.mockRejectedValue(conflict);
    const { withLeaseRetry } = await importBlob();

    const fn = vi.fn().mockResolvedValue(undefined);
    const promise = withLeaseRetry("rounds.json", fn);
    const assertion = expect(promise).rejects.toBe(conflict);
    const statusAssertion = expect(promise).rejects.toHaveProperty("statusCode", 409);
    await vi.runAllTimersAsync();

    await assertion; // ORIGINAL error identity preserved
    await statusAssertion;
    expect(azureMock.acquireLease).toHaveBeenCalledTimes(20); // maxAttempts
    expect(fn).not.toHaveBeenCalled();
  });

  test("20 consecutive 412s → throws original error after exactly maxAttempts (private)", async () => {
    const conflict = leaseError(412);
    azureMock.acquireLease.mockReset();
    azureMock.acquireLease.mockRejectedValue(conflict);
    const { withPrivateLeaseRetry } = await importBlob();

    const fn = vi.fn().mockResolvedValue("never");
    const promise = withPrivateLeaseRetry("user-index.json", fn);
    const assertion = expect(promise).rejects.toBe(conflict);
    const statusAssertion = expect(promise).rejects.toHaveProperty("statusCode", 412);
    await vi.runAllTimersAsync();

    await assertion;
    await statusAssertion;
    expect(azureMock.acquireLease).toHaveBeenCalledTimes(20);
  });

  // ─── Case 5: backoff is 25 * attempt (fake timers, no real sleeps) ─────────

  test("backoff between retries is 25 * attempt ms (public)", async () => {
    // 3 failures then success → backoffs scheduled after attempts 1,2,3.
    failThenSucceed([409, 409, 409]);
    const { withLeaseRetry } = await importBlob();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fn = vi.fn().mockResolvedValue(undefined);
    const promise = withLeaseRetry("rounds.json", fn);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();

    const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
    expect(delays).toEqual([25, 50, 75]); // 25*1, 25*2, 25*3
    expect(azureMock.acquireLease).toHaveBeenCalledTimes(4); // 3 fail + 1 ok
  });

  test("backoff between retries is 25 * attempt ms (private)", async () => {
    failThenSucceed([409, 412]); // mixed conflict codes, both retry
    const { withPrivateLeaseRetry } = await importBlob();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fn = vi.fn().mockResolvedValue("ok");
    const promise = withPrivateLeaseRetry("user-index.json", fn);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");

    const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
    expect(delays).toEqual([25, 50]); // 25*1, 25*2
  });
});
