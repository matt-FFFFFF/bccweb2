/**
 * Tests for `withRoundAndBriefLease` (apps/api/src/lib/blob.ts) — the cross-blob
 * lease primitive that T7/T8/T9 route through. Driven by a REAL Azurite lease
 * (Azurite up on :10000).
 *
 * Two independent properties:
 *
 *  1. ORDER — the round lease is acquired BEFORE the brief lease, and released
 *     in reverse (brief before round). Proven by spying on
 *     `BlobLeaseClient.prototype.acquire/releaseLease` and reading the captured
 *     `this` instances' urls (the spy calls through to the real Azurite lease).
 *
 *  2. BOTH-HELD — inside `fn`, BOTH leases are simultaneously held (observable
 *     lock state): a competing out-of-band acquire on either blob yields 409.
 *     After `fn` returns, both leases release back to "available".
 */

import { randomUUID } from "node:crypto";
import { BlobLeaseClient } from "@azure/storage-blob";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import { withRoundAndBriefLease, writePrivateBlob } from "../blob.js";

function classify(url: string): "round" | "brief" | "other" {
  if (url.includes("round-briefs/")) return "brief";
  if (url.includes("/rounds/")) return "round";
  return "other";
}

async function seedRoundAndBrief(id: string): Promise<void> {
  await writePrivateBlob(`rounds/${id}.json`, { id, status: "Confirmed" });
  await writePrivateBlob(`round-briefs/${id}.json`, { roundId: id });
}

describe("withRoundAndBriefLease (real Azurite)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("acquires round THEN brief, releases brief THEN round", async () => {
    const id = randomUUID();
    await seedRoundAndBrief(id);

    const acquireSpy = vi.spyOn(BlobLeaseClient.prototype, "acquireLease");
    const releaseSpy = vi.spyOn(BlobLeaseClient.prototype, "releaseLease");

    const result = await withRoundAndBriefLease(id, async (roundLeaseId, briefLeaseId) => {
      expect(typeof roundLeaseId).toBe("string");
      expect(roundLeaseId.length).toBeGreaterThan(0);
      expect(typeof briefLeaseId).toBe("string");
      expect(briefLeaseId.length).toBeGreaterThan(0);
      expect(briefLeaseId).not.toBe(roundLeaseId);
      return "fn-result";
    });

    expect(result).toBe("fn-result");

    const acquireOrder = acquireSpy.mock.instances.map((inst) =>
      classify((inst as BlobLeaseClient).url),
    );
    const releaseOrder = releaseSpy.mock.instances.map((inst) =>
      classify((inst as BlobLeaseClient).url),
    );

    expect(acquireOrder).toEqual(["round", "brief"]);
    expect(releaseOrder).toEqual(["brief", "round"]);
  });

  test("holds BOTH leases simultaneously inside fn, releases both after", async () => {
    const id = randomUUID();
    await seedRoundAndBrief(id);

    await withRoundAndBriefLease(id, async () => {
      // Competing out-of-band acquire on each blob must 409 — proves both held.
      await expect(
        getPrivateContainer().getBlobClient(`rounds/${id}.json`).getBlobLeaseClient().acquireLease(15),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        getPrivateContainer().getBlobClient(`round-briefs/${id}.json`).getBlobLeaseClient().acquireLease(15),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    const roundProps = await getPrivateContainer().getBlobClient(`rounds/${id}.json`).getProperties();
    const briefProps = await getPrivateContainer().getBlobClient(`round-briefs/${id}.json`).getProperties();
    expect(roundProps.leaseState).toBe("available");
    expect(briefProps.leaseState).toBe("available");
  });
});
