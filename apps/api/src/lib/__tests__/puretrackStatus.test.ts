// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { BlockBlobClient } from "@azure/storage-blob";
import { afterEach, describe, expect, test, vi } from "vitest";

import { writePrivateBlob } from "../blob.js";
import * as blobJson from "../blobJson.js";
import {
  commitPureTrackReady,
  mutatePureTrackEchoes,
  setPureTrackStatus,
} from "../puretrackStatus.js";
import { renderBriefPdfHtml } from "../pdf.js";
import {
  briefFixture,
  bytes,
  readBrief,
  readRound,
  RESULT,
  roundFixture,
  seed,
  seedRound,
} from "./puretrackStatus.fixtures.js";

const telemetry = vi.hoisted(() => ({
  trackEvent: vi.fn(),
  trackTrace: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => telemetry,
}));

afterEach(() => {
  vi.restoreAllMocks();
  telemetry.trackEvent.mockClear();
});

describe("PureTrack status and echo commits", () => {
  test("commits matching attempt and preserves scoring, frozen brief, and sign-to-fly slots", async () => {
    const round = roundFixture();
    const brief = briefFixture(round);
    await seed(round, brief);
    const signaturePath = `signatures/${round.id}/team-1-1-v4.json`;
    await writePrivateBlob(signaturePath, { immutable: "signature-ledger-entry" });
    const signatureBefore = await bytes(signaturePath);

    const result = await commitPureTrackReady(round.id, "attempt-A", "owner-A", RESULT);

    const updatedRound = await readRound(round.id);
    const updatedBrief = await readBrief(round.id);
    expect(result).toEqual({ committed: true });
    expect(updatedRound.pureTrack).toMatchObject({ status: "ready", attemptId: "attempt-A" });
    expect(updatedRound.scoring).toEqual(round.scoring);
    expect(updatedRound.teams.map((team) => team.pilots)).toEqual(
      round.teams.map((team) => team.pilots),
    );
    expect(updatedBrief).toMatchObject({
      hash: brief.hash,
      version: brief.version,
      versionHistory: brief.versionHistory,
      briefingTime: brief.briefingTime,
    });
    expect(await bytes(signaturePath)).toEqual(signatureBefore);
  });

  test("commits PureTrack echoes to the round only so the PDF brief has no links", async () => {
    const round = roundFixture();
    await seed(round, briefFixture(round));

    await commitPureTrackReady(round.id, "attempt-A", "owner-A", RESULT);

    const updatedRound = await readRound(round.id);
    const updatedBrief = await readBrief(round.id);
    expect(updatedRound.pureTrackGroupId).toBe(RESULT.roundGroupId);
    expect(updatedRound.teams.map((team) => team.pureTrackGroupId)).toEqual([101, 102]);
    expect(updatedBrief.pureTrackGroupName).toBeUndefined();
    expect(updatedBrief.pureTrackGroupSlug).toBeUndefined();
    expect(updatedBrief.teams.every((team) => team.pureTrackGroupId === undefined)).toBe(true);
    expect(updatedBrief.teams.every((team) => team.pureTrackGroupSlug === undefined)).toBe(true);
    expect(renderBriefPdfHtml(updatedBrief)).not.toContain("puretrack.io/group/");
  });

  test("commits a null result without creating or touching a brief", async () => {
    const round = roundFixture();
    await seedRound(round);

    const result = await commitPureTrackReady(round.id, "attempt-A", "owner-A", null);

    expect(result).toEqual({ committed: true });
    await expect(bytes(`round-briefs/${round.id}.json`)).rejects.toMatchObject({ statusCode: 404 });
    expect(await readRound(round.id)).not.toHaveProperty("pureTrackGroupId");
  });

  test("lets callers clear exact echoes through the compensated mutation primitive", async () => {
    const round = roundFixture();
    const brief = briefFixture(round);
    round.pureTrackGroupId = 200;
    brief.pureTrackGroupName = "stale";
    await seed(round, brief);

    const committed = await mutatePureTrackEchoes(round.id, ({ round: current, brief: frozen }) => {
      delete current.pureTrackGroupId;
      delete frozen.pureTrackGroupName;
      return true;
    });

    expect(committed).toBe(true);
    expect(await readRound(round.id)).not.toHaveProperty("pureTrackGroupId");
    expect(await readBrief(round.id)).not.toHaveProperty("pureTrackGroupName");
  });

  test("leaves the brief unchanged when the round-only commit fails", async () => {
    const round = roundFixture();
    const brief = briefFixture(round);
    await seed(round, brief);
    const beforeBrief = await bytes(`round-briefs/${round.id}.json`);
    const originalWrite = blobJson.writePrivateJson;
    vi.spyOn(blobJson, "writePrivateJson").mockImplementation(
      async (path, schema, data, leaseId, opts) => {
        if (path === `rounds/${round.id}.json`) throw new Error("injected round write failure");
        return originalWrite(path, schema, data, leaseId, opts);
      },
    );

    await expect(commitPureTrackReady(round.id, "attempt-A", "owner-A", RESULT)).rejects.toThrow(
      "injected round write failure",
    );

    expect(await bytes(`round-briefs/${round.id}.json`)).toEqual(beforeBrief);
    expect((await readRound(round.id)).pureTrack?.status).toBe("processing");
  });

  test("emits reconcile telemetry when a compensated echo mutation cannot restore the brief", async () => {
    const round = roundFixture();
    await seed(round, briefFixture(round));
    const originalWrite = blobJson.writePrivateJson;
    vi.spyOn(blobJson, "writePrivateJson").mockImplementation(
      async (path, schema, data, leaseId, opts) => {
        if (path === `rounds/${round.id}.json`) throw new Error("injected round write failure");
        return originalWrite(path, schema, data, leaseId, opts);
      },
    );
    const originalUpload = BlockBlobClient.prototype.upload;
    let briefUploads = 0;
    vi.spyOn(BlockBlobClient.prototype, "upload").mockImplementation(function (
      this: BlockBlobClient,
      data,
      length,
      options,
    ) {
      if (
        this.url.includes(`round-briefs/${round.id}.json`) &&
        options?.conditions?.leaseId !== undefined
      ) {
        briefUploads += 1;
        if (briefUploads === 2) return Promise.reject(new Error("injected rollback failure"));
      }
      return originalUpload.call(this, data, length, options);
    });

    await expect(mutatePureTrackEchoes(round.id, ({ round: current }) => {
      delete current.pureTrackGroupId;
      return true;
    })).rejects.toThrow(
      "injected round write failure",
    );

    expect((await readRound(round.id)).pureTrack?.status).toBe("processing");
    expect(telemetry.trackEvent).toHaveBeenCalledWith({
      name: "puretrack.crossBlobReconcileRequired",
      properties: expect.objectContaining({ roundId: round.id }),
    });
  });

  test("wrong attempts byte-preserve both blobs", async () => {
    const round = roundFixture();
    await seed(round, briefFixture(round));
    const roundPath = `rounds/${round.id}.json`;
    const briefPath = `round-briefs/${round.id}.json`;
    const beforeRound = await bytes(roundPath);
    const beforeBrief = await bytes(briefPath);

    const result = await commitPureTrackReady(round.id, "attempt-B", "owner-A", RESULT);

    expect(result).toEqual({ committed: false });
    expect(await bytes(roundPath)).toEqual(beforeRound);
    expect(await bytes(briefPath)).toEqual(beforeBrief);
  });

  test.each(["pending", "failed"] as const)(
    "rejects a ready commit when the matching attempt is %s",
    async (status) => {
      // Given
      const round = roundFixture();
      round.pureTrack = { ...round.pureTrack, status };
      await seed(round, briefFixture(round));
      const roundPath = `rounds/${round.id}.json`;
      const briefPath = `round-briefs/${round.id}.json`;
      const beforeRound = await bytes(roundPath);
      const beforeBrief = await bytes(briefPath);

      // When
      const result = await commitPureTrackReady(round.id, "attempt-A", "owner-A", RESULT);

      // Then
      expect(result).toEqual({ committed: false });
      expect(await bytes(roundPath)).toEqual(beforeRound);
      expect(await bytes(briefPath)).toEqual(beforeBrief);
    },
  );

  test("status CAS enforces round, active-status, attempt, and source-status guards", async () => {
    const round = roundFixture();
    await seed(round, briefFixture(round));

    const active = await setPureTrackStatus(round.id, "pending", {
      newAttemptId: "attempt-B",
      requireRoundStatuses: ["Locked", "Complete"],
      rejectStatuses: ["pending", "processing"],
    });
    const stale = await setPureTrackStatus(round.id, "failed", {
      expectAttemptId: "attempt-B",
      fromStatuses: ["pending"],
      error: "worker_failed",
    });

    expect(active).toEqual({ updated: false, previousStatus: "processing" });
    expect(stale).toEqual({ updated: false, previousStatus: "processing" });
  });

  test("starts a fresh eligible attempt and redacts unsafe failure details", async () => {
    const round = roundFixture();
    round.pureTrack = { status: "ready", attemptId: "attempt-A", updatedAt: "before" };
    await seed(round, briefFixture(round));

    const started = await setPureTrackStatus(round.id, "pending", {
      newAttemptId: "attempt-B",
      requireRoundStatuses: ["Locked", "Complete"],
      rejectStatuses: ["pending", "processing"],
    });
    const failed = await setPureTrackStatus(round.id, "failed", {
      expectAttemptId: "attempt-B",
      fromStatuses: ["pending"],
      error: "email matt@example.test",
    });

    expect(started).toEqual({ updated: true, previousStatus: "ready" });
    expect(failed).toEqual({ updated: true, previousStatus: "pending" });
    expect((await readRound(round.id)).pureTrack).toMatchObject({
      status: "failed",
      attemptId: "attempt-B",
      error: "PureTrack group operation failed",
    });
  });
});
