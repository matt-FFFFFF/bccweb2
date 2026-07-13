// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test, vi } from "vitest";

import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import {
  acquirePureTrackMutationGuard,
  releasePureTrackGuard,
} from "../puretrackGuard.js";
import { commitPureTrackReady, setPureTrackStatus } from "../puretrackStatus.js";
import {
  briefFixture,
  bytes,
  readRound,
  RESULT,
  roundFixture,
  seed,
} from "./puretrackStatus.fixtures.js";

afterEach(() => {
  vi.useRealTimers();
});

test("rejects a former owner's commit and retry status writes after takeover", async () => {
  // Given
  const round = roundFixture();
  round.pureTrack = { ...round.pureTrack, status: "pending", ownerToken: undefined };
  await seed(round, briefFixture(round));
  const former = await acquirePureTrackMutationGuard("global", "attempt-A");
  if (former === null) throw new Error("initial guard acquisition unexpectedly contended");
  await setPureTrackStatus(round.id, "processing", {
    expectAttemptId: "attempt-A",
    fromStatuses: ["pending"],
    newOwnerToken: former.ownerToken,
  });
  const guardProperties = await getPrivateContainer()
    .getBlobClient("puretrack-jobs/active/global.json")
    .getProperties();
  const modifiedAt = guardProperties.lastModified?.getTime();
  if (modifiedAt === undefined) throw new Error("Azurite omitted guard lastModified");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(modifiedAt + 12 * 60 * 1000);
  const current = await acquirePureTrackMutationGuard("global", "attempt-A");
  if (current === null) throw new Error("stale guard takeover unexpectedly contended");
  await setPureTrackStatus(round.id, "processing", {
    expectAttemptId: "attempt-A",
    fromStatuses: ["processing"],
    newOwnerToken: current.ownerToken,
  });
  const roundPath = `rounds/${round.id}.json`;
  const beforeFormerWrites = await bytes(roundPath);

  // When
  const stalePending = await setPureTrackStatus(round.id, "pending", {
    expectAttemptId: "attempt-A",
    expectOwnerToken: former.ownerToken,
    fromStatuses: ["processing"],
  });
  const staleFailed = await setPureTrackStatus(round.id, "failed", {
    expectAttemptId: "attempt-A",
    expectOwnerToken: former.ownerToken,
    fromStatuses: ["processing"],
  });
  const staleCommit = await commitPureTrackReady(
    round.id,
    "attempt-A",
    former.ownerToken,
    RESULT,
  );

  // Then
  expect(stalePending).toEqual({ updated: false, previousStatus: "processing" });
  expect(staleFailed).toEqual({ updated: false, previousStatus: "processing" });
  expect(staleCommit).toEqual({ committed: false });
  expect(await bytes(roundPath)).toEqual(beforeFormerWrites);

  // When
  const currentCommit = await commitPureTrackReady(
    round.id,
    "attempt-A",
    current.ownerToken,
    RESULT,
  );

  // Then
  expect(currentCommit).toEqual({ committed: true });
  expect((await readRound(round.id)).pureTrack).toMatchObject({
    status: "ready",
    ownerToken: current.ownerToken,
  });
  await releasePureTrackGuard(former);
  await releasePureTrackGuard(current);
});
