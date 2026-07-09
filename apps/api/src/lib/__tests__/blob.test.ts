// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { getPublicContainer } from "../../__tests__/helpers/azurite.js";

const telemetryMock = vi.hoisted(() => {
  const trackTrace = vi.fn();
  return { trackTrace, client: { trackTrace } };
});

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => telemetryMock.client),
  setup: vi.fn(),
  resetForTests: vi.fn(),
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function importBlob(): Promise<typeof import("../blob.js")> {
  return import("../blob.js");
}

describe("withLeaseRenewing", () => {
  beforeEach(() => {
    vi.resetModules();
    telemetryMock.trackTrace.mockClear();
  });

  test("60s op succeeds with >=3 renewals", async () => {
    vi.setConfig({ testTimeout: 70_000 });
    const { withLeaseRenewing, writeBlob } = await importBlob();
    const path = `lease-renew/${randomUUID()}.json`;
    await writeBlob(path, { value: "initial" });

    await withLeaseRenewing(
      path,
      async (leaseId) => {
        await sleep(60_000);
        await writeBlob(path, { value: "updated" }, leaseId);
      },
      { leaseDurationSec: 31, renewIntervalMs: 15_000 }
    );

    const renewals = telemetryMock.trackTrace.mock.calls.filter(
      ([trace]) => trace.message === "Blob lease renewed"
    );
    expect(renewals.length).toBeGreaterThanOrEqual(3);
    const blob = getPublicContainer().getBlobClient(path);
    const properties = await blob.getProperties();
    expect(properties.leaseState).toBe("available");
  });

  test("releases on fn throw", async () => {
    const { withLeaseRenewing, writeBlob } = await importBlob();
    const path = `lease-renew/${randomUUID()}.json`;
    await writeBlob(path, { value: "initial" });

    await expect(
      withLeaseRenewing(
        path,
        async () => {
          throw new Error("boom");
        },
        { leaseDurationSec: 15, renewIntervalMs: 1_000 }
      )
    ).rejects.toThrow("boom");

    const blob = getPublicContainer().getBlobClient(path);
    const properties = await blob.getProperties();
    expect(properties.leaseState).toBe("available");
  });

  test("force-break of lease causes LeaseRenewalFailedError", async () => {
    const { LeaseRenewalFailedError, withLeaseRenewing, writeBlob } =
      await importBlob();
    const path = `lease-renew/${randomUUID()}.json`;
    await writeBlob(path, { value: "initial" });
    const blob = getPublicContainer().getBlockBlobClient(path);

    await expect(
      withLeaseRenewing(
        path,
        async () => {
          await sleep(500);
          await blob.getBlobLeaseClient().breakLease(0);
          await sleep(1_500);
        },
        { leaseDurationSec: 15, renewIntervalMs: 1_000 }
      )
    ).rejects.toBeInstanceOf(LeaseRenewalFailedError);

    const properties = await blob.getProperties();
    expect(properties.leaseState).toBe("available");
  });
});
