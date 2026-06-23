/**
 * Tests for the shared `withLease` / `withPrivateLease` lease wrappers
 * (apps/api/src/lib/blob.ts:149-195).
 *
 * Three concerns:
 *
 *  1. Serialization (CHARACTERIZATION, GREEN against current code) — driven by a
 *     REAL Azurite lease (Azurite up on :10000). Two sequential `withLease`
 *     calls each acquire+release; a contention case where a second acquire
 *     while the blob is already leased yields HTTP 409.
 *
 *  2. Guarded success-release (NEW behavior, RED until T8) — when `fn` succeeds
 *     but `releaseLease()` throws, `withLease` should RESOLVE with `fn`'s result
 *     and attempt release exactly once. Today the success-path `await
 *     leaseClient.releaseLease()` is UNGUARDED, so the rejection propagates and
 *     `fn`'s result is discarded — this case FAILS until T8 mirrors the
 *     `withLeaseRenewingOnClient` guarded `finally` (blob.ts:264-273).
 *
 *  3. Error-path release stays best-effort (GREEN now) — when `fn` throws,
 *     `fn`'s error propagates and the release failure is swallowed.
 *
 * IMPORTANT (T2 probe finding): real Azurite `releaseLease()` on a broken /
 * expired lease does NOT throw. The guarded-release and error-path cases
 * therefore drive release failure via a MOCKED lease client whose
 * `releaseLease` rejects — a real broken lease would make these tests vacuous.
 * The mocked cases use `vi.doMock` (non-hoisted) + `vi.resetModules()` + a
 * dynamic `import("../blob.js")` so they do NOT disturb the real
 * `@azure/storage-blob` used by the serialization cases (which rely on the
 * statically-imported, real `withLease`/`writeBlob`).
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getPublicContainer } from "../../__tests__/helpers/azurite.js";
import { withLease, writeBlob } from "../blob.js";

// ─── Serialization (characterization, REAL Azurite, GREEN now) ─────────────────

describe("withLease serialization (real Azurite)", () => {
  test("two sequential calls each acquire and release the lease", async () => {
    const path = `lease/${randomUUID()}.json`;
    await writeBlob(path, { v: 0 });

    const first = await withLease(path, async (leaseId) => {
      expect(typeof leaseId).toBe("string");
      expect(leaseId.length).toBeGreaterThan(0);
      return "first";
    });
    expect(first).toBe("first");

    // Released after the first call → blob lease state is available again.
    let props = await getPublicContainer().getBlobClient(path).getProperties();
    expect(props.leaseState).toBe("available");

    // The second call can therefore acquire the lease without contention.
    const second = await withLease(path, async () => "second");
    expect(second).toBe("second");

    props = await getPublicContainer().getBlobClient(path).getProperties();
    expect(props.leaseState).toBe("available");
  });

  test("acquiring while the blob is already leased yields 409", async () => {
    const path = `lease/${randomUUID()}.json`;
    await writeBlob(path, { v: 0 });

    // Hold a real lease out-of-band so withLease's own acquireLease contends.
    const leaseClient = getPublicContainer()
      .getBlobClient(path)
      .getBlobLeaseClient();
    await leaseClient.acquireLease(30);

    try {
      await expect(
        withLease(path, async () => "should-not-run"),
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await leaseClient.releaseLease();
    }
  });
});

// ─── Mocked lease client (release failure injection) ───────────────────────────

/**
 * Build a minimal `@azure/storage-blob` mock whose blob lease client uses the
 * supplied `acquireLease` / `releaseLease` spies. Mirrors the singleton mock
 * pattern in blob.singleton.test.ts — only `BlobServiceClient.fromConnectionString`
 * is needed at runtime (the other named imports are type-only positions).
 */
function makeStorageMock(
  acquireLease: ReturnType<typeof vi.fn>,
  releaseLease: ReturnType<typeof vi.fn>,
) {
  const leaseClient = { acquireLease, releaseLease };
  const blockBlobClient = { getBlobLeaseClient: () => leaseClient };
  const containerClient = {
    getBlobClient: () => blockBlobClient,
    getBlockBlobClient: () => blockBlobClient,
  };
  const service = { getContainerClient: () => containerClient };
  return {
    BlobServiceClient: { fromConnectionString: () => service },
  };
}

async function importBlobWithMockedRelease(
  releaseLease: ReturnType<typeof vi.fn>,
) {
  const acquireLease = vi.fn().mockResolvedValue({ leaseId: "mock-lease-id" });
  const trackTrace = vi.fn();
  vi.resetModules();
  vi.doMock("@azure/storage-blob", () =>
    makeStorageMock(acquireLease, releaseLease),
  );
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: () => ({ trackTrace }),
    setup: vi.fn(),
    resetForTests: vi.fn(),
  }));
  const mod = await import("../blob.js");
  return { mod, acquireLease, trackTrace };
}

describe("withLease guarded success-release (mocked, RED until T8)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@azure/storage-blob");
    vi.doUnmock("../telemetry.js");
    vi.resetModules();
  });

  test("withLease resolves with fn's result even when releaseLease throws", async () => {
    const releaseLease = vi
      .fn()
      .mockRejectedValue(new Error("release boom on success"));
    const { mod } = await importBlobWithMockedRelease(releaseLease);

    const result = await mod.withLease("some/path.json", async (leaseId) => {
      expect(leaseId).toBe("mock-lease-id");
      return "FN_RESULT";
    });

    // RED until T8: today the unguarded success-path `await releaseLease()`
    // rejects and discards FN_RESULT, so withLease throws instead of resolving.
    expect(result).toBe("FN_RESULT");
    // Release attempted exactly once on the happy path — no double-release.
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  test("releaseLease failure emits a 'Blob lease release failed' trace with safe props", async () => {
    const releaseLease = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("release-secret-detail"), { statusCode: 409 }));
    const { mod, trackTrace } = await importBlobWithMockedRelease(releaseLease);

    const result = await mod.withLease("some/path.json", async () => "FN_RESULT");

    expect(result).toBe("FN_RESULT");
    const failureCall = trackTrace.mock.calls.find(
      ([arg]) => (arg as { message: string }).message === "Blob lease release failed",
    );
    expect(failureCall).toBeDefined();
    expect(failureCall?.[0].properties).toMatchObject({
      path: "some/path.json",
      leaseId: "mock-lease-id",
      errorName: "Error",
      statusCode: 409,
    });
    expect(JSON.stringify(failureCall?.[0].properties)).not.toContain("release-secret-detail");
  });

  test("withPrivateLease resolves with fn's result even when releaseLease throws", async () => {
    const releaseLease = vi
      .fn()
      .mockRejectedValue(new Error("release boom on success"));
    const { mod } = await importBlobWithMockedRelease(releaseLease);

    const result = await mod.withPrivateLease(
      "priv/path.json",
      async (leaseId) => {
        expect(leaseId).toBe("mock-lease-id");
        return "PRIV_RESULT";
      },
    );

    expect(result).toBe("PRIV_RESULT");
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });
});

describe("withLease error-path release stays best-effort (mocked, GREEN now)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@azure/storage-blob");
    vi.doUnmock("../telemetry.js");
    vi.resetModules();
  });

  test("fn's error propagates and release failure is swallowed", async () => {
    const releaseLease = vi
      .fn()
      .mockRejectedValue(new Error("release boom on error"));
    const { mod } = await importBlobWithMockedRelease(releaseLease);

    const fnError = new Error("fn boom");
    await expect(
      mod.withLease("some/path.json", async () => {
        throw fnError;
      }),
    ).rejects.toBe(fnError);

    // Release attempted once; its rejection is swallowed by the best-effort
    // `.catch(() => {})` so only fn's error surfaces.
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });
});
