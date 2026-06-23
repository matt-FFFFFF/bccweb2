/**
 * Characterization + RED-contract tests for `withLeaseRenewing` (public) in
 * apps/api/src/lib/blob.ts (currently `withLeaseRenewingOnClient`, lines 223-274).
 *
 * Four behaviours are pinned here:
 *
 *  1. Re-entrancy guard (NEW — RED until T8): when `renewLease()` takes longer
 *     than `renewIntervalMs`, interval ticks MUST NOT start a second renew while
 *     one is in flight. We track concurrent in-flight `renewLease` invocations and
 *     assert max concurrency === 1. The CURRENT code (a bare `setInterval` with an
 *     async callback and no guard) overlaps renews → concurrency reaches 2 → RED.
 *
 *  2. Throw ordering (characterization — GREEN now): `LeaseRenewalFailedError` is
 *     thrown ONLY when `fn` resolved but a renew failed. If `fn` itself throws,
 *     `fn`'s error wins and NO `LeaseRenewalFailedError` is produced.
 *
 *  3. Logging via telemetry (NEW — RED until T8): lease acquire/renew/release must
 *     emit through `getTelemetryClient()?.trackTrace(...)` (the API chosen in T1),
 *     NOT `console.log`. The CURRENT code uses `console.log("[lease] …")` and never
 *     touches telemetry → both telemetry-called and no-console-log assertions RED.
 *
 *  4. opts validation (characterization — GREEN now): `renewIntervalMs >
 *     leaseDurationSec * 500` still throws "renewal interval too long"; the
 *     `{ renewIntervalMs: 1_000 }` 3-arg shape (and the bare 2-arg call) still pass.
 *
 * LIGHT / default-suite: the lease layer is mocked at the @azure/storage-blob seam,
 * so renew timing/overlap is injected WITHOUT Azurite and WITHOUT real wall-clock
 * waits (`vi.useFakeTimers()` drives the interval + renew durations). Telemetry is
 * mocked at `../telemetry.js` so trace emission is observable without App Insights.
 *
 * Mock seam mirrors blob.leaseRetry.test.ts: the shared setup files cache `blob.js`
 * against the REAL @azure/storage-blob, so each test does `vi.resetModules()` and a
 * dynamic `import("../blob.js")` to pick up the mocked package (and the mocked
 * telemetry module, once T8 wires it in).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const LEASE_ID = "lease-test-id";

// ─── Controllable lease-client mock (the injection seam) ─────────────────────
//
// blob.ts builds its clients from BlobServiceClient.fromConnectionString(...).
// We replace that so getBlockBlobClient(...) ultimately hands back a lease client
// whose acquireLease/renewLease/releaseLease we control per test.
const azureMock = vi.hoisted(() => {
  const acquireLease = vi.fn();
  const renewLease = vi.fn();
  const releaseLease = vi.fn().mockResolvedValue(undefined);
  const leaseClient = { acquireLease, renewLease, releaseLease };
  const blockBlobClient = { getBlobLeaseClient: () => leaseClient };
  const containerClient = {
    getBlobClient: () => ({}),
    getBlockBlobClient: () => blockBlobClient,
  };
  const fromConnectionString = vi.fn(() => ({
    getContainerClient: () => containerClient,
  }));
  return { acquireLease, renewLease, releaseLease, fromConnectionString };
});

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: { fromConnectionString: azureMock.fromConnectionString },
}));

// ─── Telemetry mock (the trace seam chosen in T1) ────────────────────────────
//
// T1 decision: lease traces go through `getTelemetryClient()?.trackTrace(...)`
// imported from `./telemetry.js`. We spy on trackTrace via a stable hoisted
// client so it survives `vi.resetModules()`.
const telemetryMock = vi.hoisted(() => {
  const trackTrace = vi.fn();
  return { trackTrace, client: { trackTrace } };
});

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => telemetryMock.client),
  setup: vi.fn(),
  resetForTests: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Dynamically import the (post-reset) blob module with the mocks in place. */
async function importBlob(): Promise<typeof import("../blob.js")> {
  return import("../blob.js");
}

/** A `fn` that resolves with `value` after `ms` of (faked) wall-clock. */
function fnResolvingAfter<T>(ms: number, value: T): () => Promise<T> {
  return () => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
}

/** A `fn` that rejects with `err` after `ms` of (faked) wall-clock. */
function fnRejectingAfter(ms: number, err: unknown): () => Promise<never> {
  return () => new Promise<never>((_resolve, reject) => setTimeout(() => reject(err), ms));
}

beforeEach(() => {
  // Re-load blob.js against the mocked @azure/storage-blob + ../telemetry.js (the
  // shared setup files cache it with the real packages otherwise).
  vi.resetModules();

  azureMock.acquireLease.mockReset();
  azureMock.acquireLease.mockResolvedValue({ leaseId: LEASE_ID });
  azureMock.renewLease.mockReset();
  azureMock.renewLease.mockResolvedValue(undefined);
  azureMock.releaseLease.mockReset();
  azureMock.releaseLease.mockResolvedValue(undefined);
  azureMock.fromConnectionString.mockClear();
  telemetryMock.trackTrace.mockClear();

  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── 1. Re-entrancy guard (NEW — RED until T8) ───────────────────────────────

describe("withLeaseRenewing — re-entrancy guard (RED until T8)", () => {
  test("renews never overlap: max in-flight renewLease concurrency === 1", async () => {
    const RENEW_INTERVAL = 1_000;
    const RENEW_DURATION = 2 * RENEW_INTERVAL; // each renew outlives one interval
    const FN_DURATION = 6 * RENEW_INTERVAL; // ~6 ticks while fn runs

    const tracker = { inFlight: 0, maxConcurrency: 0, calls: 0 };
    azureMock.renewLease.mockImplementation(() => {
      tracker.calls += 1;
      tracker.inFlight += 1;
      tracker.maxConcurrency = Math.max(tracker.maxConcurrency, tracker.inFlight);
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          tracker.inFlight -= 1;
          resolve();
        }, RENEW_DURATION);
      });
    });

    const { withLeaseRenewing } = await importBlob();
    const fn = vi.fn(fnResolvingAfter(FN_DURATION, "done"));

    const promise = withLeaseRenewing("rounds.json", fn, {
      leaseDurationSec: 30,
      renewIntervalMs: RENEW_INTERVAL,
    });

    await vi.advanceTimersByTimeAsync(FN_DURATION);
    await expect(promise).resolves.toBe("done");

    // Sanity: renews actually fired while fn ran.
    expect(tracker.calls).toBeGreaterThan(0);
    // RED until T8: the current bare setInterval overlaps renews (concurrency 2).
    expect(tracker.maxConcurrency).toBe(1);
  });
});

// ─── 2. Throw ordering (characterization — GREEN now) ────────────────────────

describe("withLeaseRenewing — throw ordering (characterization, GREEN now)", () => {
  test("fn succeeds but a renew fails → throws LeaseRenewalFailedError", async () => {
    const RENEW_INTERVAL = 1_000;
    const FN_DURATION = 2 * RENEW_INTERVAL; // long enough for one renew tick to fail

    azureMock.renewLease.mockRejectedValue(new Error("renew-broke"));

    const { withLeaseRenewing, LeaseRenewalFailedError } = await importBlob();
    const fn = vi.fn(fnResolvingAfter(FN_DURATION, "fn-ok"));

    let caught: unknown;
    const settled = withLeaseRenewing("rounds.json", fn, {
      leaseDurationSec: 30,
      renewIntervalMs: RENEW_INTERVAL,
    }).then(
      () => {
        throw new Error("expected rejection");
      },
      (err: unknown) => {
        caught = err;
      },
    );

    await vi.advanceTimersByTimeAsync(FN_DURATION);
    await settled;

    expect(caught).toBeInstanceOf(LeaseRenewalFailedError);
  });

  test("fn throws → fn's error wins, NO LeaseRenewalFailedError (even if a renew also failed)", async () => {
    const RENEW_INTERVAL = 1_000;
    const FN_DURATION = 2 * RENEW_INTERVAL;

    // Renew also fails, to prove fn's error takes precedence in the finally block.
    azureMock.renewLease.mockRejectedValue(new Error("renew-broke"));

    const { withLeaseRenewing, LeaseRenewalFailedError } = await importBlob();
    const boom = new Error("boom");
    const fn = vi.fn(fnRejectingAfter(FN_DURATION, boom));

    let caught: unknown;
    const settled = withLeaseRenewing("rounds.json", fn, {
      leaseDurationSec: 30,
      renewIntervalMs: RENEW_INTERVAL,
    }).then(
      () => {
        throw new Error("expected rejection");
      },
      (err: unknown) => {
        caught = err;
      },
    );

    await vi.advanceTimersByTimeAsync(FN_DURATION);
    await settled;

    expect(caught).toBe(boom);
    expect(caught).not.toBeInstanceOf(LeaseRenewalFailedError);
  });
});

// ─── 3. Logging via telemetry (NEW — RED until T8) ───────────────────────────

describe("withLeaseRenewing — telemetry logging (RED until T8)", () => {
  test("lease lifecycle emits via getTelemetryClient().trackTrace, not console.log", async () => {
    const RENEW_INTERVAL = 1_000;
    const FN_DURATION = 2 * RENEW_INTERVAL; // allows acquire + ≥1 renew + release

    azureMock.renewLease.mockResolvedValue(undefined);

    const { withLeaseRenewing } = await importBlob();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fn = vi.fn(fnResolvingAfter(FN_DURATION, "ok"));

    const promise = withLeaseRenewing("rounds.json", fn, {
      leaseDurationSec: 30,
      renewIntervalMs: RENEW_INTERVAL,
    });

    await vi.advanceTimersByTimeAsync(FN_DURATION);
    await expect(promise).resolves.toBe("ok");

    // RED until T8: lease events must route through telemetry.
    expect(telemetryMock.trackTrace).toHaveBeenCalled();

    // RED until T8: no "[lease] …" console.log lines may remain.
    const leaseLogs = logSpy.mock.calls.filter(
      ([msg]) => typeof msg === "string" && msg.startsWith("[lease]"),
    );
    expect(leaseLogs).toHaveLength(0);
  });
});

// ─── 3b. Release-failure telemetry (PR #26 round-3) ──────────────────────────

describe("withLeaseRenewing — release-failure telemetry", () => {
  const traceMessages = () =>
    telemetryMock.trackTrace.mock.calls.map(([arg]) => (arg as { message: string }).message);

  test("releaseLease throws → emits 'Blob lease release failed', NOT 'Blob lease released'", async () => {
    const RENEW_INTERVAL = 1_000;
    const FN_DURATION = 2 * RENEW_INTERVAL;

    azureMock.renewLease.mockResolvedValue(undefined);
    const releaseErr = Object.assign(new Error("release-broke"), { statusCode: 409 });
    azureMock.releaseLease.mockRejectedValue(releaseErr);

    const { withLeaseRenewing } = await importBlob();
    const fn = vi.fn(fnResolvingAfter(FN_DURATION, "ok"));

    const promise = withLeaseRenewing("rounds.json", fn, {
      leaseDurationSec: 30,
      renewIntervalMs: RENEW_INTERVAL,
    });

    await vi.advanceTimersByTimeAsync(FN_DURATION);
    await expect(promise).resolves.toBe("ok");

    const messages = traceMessages();
    expect(messages).toContain("Blob lease release failed");
    expect(messages).not.toContain("Blob lease released");

    const failureCall = telemetryMock.trackTrace.mock.calls.find(
      ([arg]) => (arg as { message: string }).message === "Blob lease release failed",
    );
    expect(failureCall?.[0].properties).toMatchObject({
      path: "rounds.json",
      leaseId: LEASE_ID,
      errorName: "Error",
      statusCode: 409,
    });
    expect(JSON.stringify(failureCall?.[0].properties)).not.toContain("release-broke");
  });

  test("releaseLease succeeds → emits 'Blob lease released', NOT 'Blob lease release failed'", async () => {
    const RENEW_INTERVAL = 1_000;
    const FN_DURATION = 2 * RENEW_INTERVAL;

    azureMock.renewLease.mockResolvedValue(undefined);
    azureMock.releaseLease.mockResolvedValue(undefined);

    const { withLeaseRenewing } = await importBlob();
    const fn = vi.fn(fnResolvingAfter(FN_DURATION, "ok"));

    const promise = withLeaseRenewing("rounds.json", fn, {
      leaseDurationSec: 30,
      renewIntervalMs: RENEW_INTERVAL,
    });

    await vi.advanceTimersByTimeAsync(FN_DURATION);
    await expect(promise).resolves.toBe("ok");

    const messages = traceMessages();
    expect(messages).toContain("Blob lease released");
    expect(messages).not.toContain("Blob lease release failed");
  });
});

// ─── 4. opts validation (characterization — GREEN now) ───────────────────────

describe("withLeaseRenewing — opts validation (characterization, GREEN now)", () => {
  test("renewIntervalMs > leaseDurationSec * 500 throws 'renewal interval too long'", async () => {
    const { withLeaseRenewing } = await importBlob();
    const fn = vi.fn();

    // 2 * 500 = 1000; 2000 > 1000 → reject before acquiring any lease.
    await expect(
      withLeaseRenewing("rounds.json", fn, { leaseDurationSec: 2, renewIntervalMs: 2_000 }),
    ).rejects.toThrow("renewal interval too long");

    expect(fn).not.toHaveBeenCalled();
    expect(azureMock.acquireLease).not.toHaveBeenCalled();
  });

  test("{ renewIntervalMs: 1_000 } (3-arg shape) still passes", async () => {
    const { withLeaseRenewing } = await importBlob();
    const fn = vi.fn(async () => "value");

    const promise = withLeaseRenewing("rounds.json", fn, { renewIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe("value");
    expect(fn).toHaveBeenCalledWith(LEASE_ID);
    // default leaseDurationSec is 30 → acquireLease(30)
    expect(azureMock.acquireLease).toHaveBeenCalledWith(30);
  });

  test("2-arg call (no opts) still passes with defaults", async () => {
    const { withLeaseRenewing } = await importBlob();
    const fn = vi.fn(async () => "two-arg");

    const promise = withLeaseRenewing("rounds.json", fn);
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe("two-arg");
    expect(azureMock.acquireLease).toHaveBeenCalledWith(30);
  });
});
