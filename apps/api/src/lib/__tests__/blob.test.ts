import { randomUUID } from "crypto";
import { describe, expect, test, vi } from "vitest";
import { getPublicContainer } from "../../__tests__/helpers/azurite.js";
import {
  LeaseRenewalFailedError,
  withLeaseRenewing,
  writeBlob,
} from "../blob.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withLeaseRenewing", () => {
  test("60s op succeeds with >=3 renewals", async () => {
    vi.setConfig({ testTimeout: 70_000 });
    const path = `lease-renew/${randomUUID()}.json`;
    await writeBlob(path, { value: "initial" });
    const logs: unknown[][] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args);
    });

    try {
      await withLeaseRenewing(
        path,
        async (leaseId) => {
          await sleep(60_000);
          await writeBlob(path, { value: "updated" }, leaseId);
        },
        { leaseDurationSec: 31, renewIntervalMs: 15_000 }
      );
    } finally {
      logSpy.mockRestore();
    }

    const renewals = logs.filter(([message]) => message === "[lease] renewed");
    expect(renewals.length).toBeGreaterThanOrEqual(3);
    const blob = getPublicContainer().getBlobClient(path);
    const properties = await blob.getProperties();
    expect(properties.leaseState).toBe("available");
  });

  test("releases on fn throw", async () => {
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
