// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import {
  acquirePureTrackMutationGuard,
  assertPureTrackGuardOwned,
  releasePureTrackGuard,
} from "../puretrackGuard.js";

const GUARD_PATH = "puretrack-jobs/active/global.json";
const STALE_MS = 12 * 60 * 1000;

beforeEach(async () => {
  await getPrivateContainer().getBlobClient(GUARD_PATH).deleteIfExists();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PureTrack global mutation guard", () => {
  test("uses the global private guard blob and treats exactly 12 minutes as stale", async () => {
    const first = await acquirePureTrackMutationGuard("global", "attempt-A");
    expect(first).not.toBeNull();
    const client = getPrivateContainer().getBlobClient(GUARD_PATH);
    const properties = await client.getProperties();
    const modifiedAt = properties.lastModified?.getTime();
    expect(modifiedAt).toBeDefined();
    if (modifiedAt === undefined) throw new Error("Azurite omitted guard lastModified");

    vi.useFakeTimers();
    vi.setSystemTime(modifiedAt + STALE_MS - 1);
    expect(await acquirePureTrackMutationGuard("global", "attempt-B")).toBeNull();

    vi.setSystemTime(modifiedAt + STALE_MS);
    const takeover = await acquirePureTrackMutationGuard("global", "attempt-B");
    expect(takeover).toMatchObject({ scope: "global" });
  });

  test("allows only one ETag-conditioned winner in a stale takeover race", async () => {
    await acquirePureTrackMutationGuard("global", "attempt-A");
    const properties = await getPrivateContainer().getBlobClient(GUARD_PATH).getProperties();
    const modifiedAt = properties.lastModified?.getTime();
    if (modifiedAt === undefined) throw new Error("Azurite omitted guard lastModified");
    vi.useFakeTimers();
    vi.setSystemTime(modifiedAt + STALE_MS);

    const contenders = await Promise.all([
      acquirePureTrackMutationGuard("global", "attempt-B"),
      acquirePureTrackMutationGuard("global", "attempt-C"),
    ]);

    expect(contenders.filter((handle) => handle !== null)).toHaveLength(1);
  });

  test("blocks a former owner before its next outbound call", async () => {
    const former = await acquirePureTrackMutationGuard("global", "attempt-A");
    if (former === null) throw new Error("initial guard acquisition unexpectedly contended");
    const properties = await getPrivateContainer().getBlobClient(GUARD_PATH).getProperties();
    const modifiedAt = properties.lastModified?.getTime();
    if (modifiedAt === undefined) throw new Error("Azurite omitted guard lastModified");
    vi.useFakeTimers();
    vi.setSystemTime(modifiedAt + STALE_MS);
    const current = await acquirePureTrackMutationGuard("global", "attempt-B");
    if (current === null) throw new Error("stale guard takeover unexpectedly contended");

    await expect(assertPureTrackGuardOwned(former)).rejects.toThrow(/ownership/i);
    await expect(assertPureTrackGuardOwned(current)).resolves.toBeUndefined();
  });

  test("makes a former owner's late release safe for the replacement owner", async () => {
    const former = await acquirePureTrackMutationGuard("global", "attempt-A");
    if (former === null) throw new Error("initial guard acquisition unexpectedly contended");
    const properties = await getPrivateContainer().getBlobClient(GUARD_PATH).getProperties();
    const modifiedAt = properties.lastModified?.getTime();
    if (modifiedAt === undefined) throw new Error("Azurite omitted guard lastModified");
    vi.useFakeTimers();
    vi.setSystemTime(modifiedAt + STALE_MS);
    const current = await acquirePureTrackMutationGuard("global", "attempt-B");
    if (current === null) throw new Error("stale guard takeover unexpectedly contended");

    await releasePureTrackGuard(former);

    await expect(assertPureTrackGuardOwned(current)).resolves.toBeUndefined();
    await releasePureTrackGuard(current);
    expect(await getPrivateContainer().getBlobClient(GUARD_PATH).exists()).toBe(false);
  });
});
