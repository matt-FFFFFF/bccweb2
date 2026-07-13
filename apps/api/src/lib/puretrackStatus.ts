// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type {
  PureTrackStatus,
  Round,
  RoundBrief,
} from "@bccweb/types";
import { BriefSchema, RoundSchema } from "@bccweb/schemas";

import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  withPrivateLease,
  withRoundAndBriefLease,
  writePrivateBlob,
} from "./blob.js";
import { readJson, writePrivateJson } from "./blobJson.js";
import type { PureTrackRoundResult } from "./puretrack.js";
import type { SetPureTrackStatusOptions } from "./puretrackStatusTypes.js";
import { getTelemetryClient } from "./telemetry.js";

export type { SetPureTrackStatusOptions } from "./puretrackStatusTypes.js";

const MAX_PURETRACK_ERROR_LENGTH = 200;
const REDACTED_ERROR_TEXT = "PureTrack group operation failed";
const SAFE_PURETRACK_ERROR_CODE = /^[A-Za-z0-9_-]+$/;

export interface PureTrackEchoMutationContext {
  readonly round: Round;
  readonly brief: RoundBrief;
}

export type PureTrackEchoMutation = (
  context: PureTrackEchoMutationContext,
) => boolean | Promise<boolean>;

export async function setPureTrackStatus(
  roundId: string,
  status: PureTrackStatus,
  opts: SetPureTrackStatusOptions = {},
): Promise<{ updated: boolean; previousStatus?: PureTrackStatus }> {
  const roundPath = `rounds/${roundId}.json`;

  return withPrivateLease(roundPath, async (leaseId) => {
    const round: Round = await readJson(
      getPrivateBlobClient(roundPath),
      RoundSchema,
      roundPath,
    );
    const previousStatus = round.pureTrack?.status;

    if (opts.newAttemptId !== undefined) {
      if (
        opts.requireRoundStatuses !== undefined &&
        !opts.requireRoundStatuses.includes(round.status)
      ) {
        return statusResult(false, previousStatus);
      }
      if (
        previousStatus !== undefined &&
        opts.rejectStatuses?.includes(previousStatus) === true &&
        !isStalePureTrackAttempt(round.pureTrack?.updatedAt, opts.supersedeRejectedAfterMs)
      ) {
        return statusResult(false, previousStatus);
      }

      round.pureTrack = {
        attemptId: opts.newAttemptId,
        status,
        updatedAt: new Date().toISOString(),
      };
      await writePrivateJson(roundPath, RoundSchema, round, leaseId);
      return statusResult(true, previousStatus);
    }

    if (
      opts.expectAttemptId !== undefined &&
      opts.expectAttemptId !== round.pureTrack?.attemptId
    ) {
      return statusResult(false, previousStatus);
    }
    if (
      opts.expectOwnerToken !== undefined &&
      opts.expectOwnerToken !== round.pureTrack?.ownerToken
    ) {
      return statusResult(false, previousStatus);
    }
    if (
      opts.fromStatuses !== undefined &&
      (previousStatus === undefined || !opts.fromStatuses.includes(previousStatus))
    ) {
      return statusResult(false, previousStatus);
    }

    round.pureTrack = {
      ...round.pureTrack,
      status,
      updatedAt: new Date().toISOString(),
    };
    if (opts.newOwnerToken !== undefined) {
      round.pureTrack.ownerToken = opts.newOwnerToken;
    }
    const pureTrackError = sanitizePureTrackError(opts.error);
    if (pureTrackError === undefined) {
      delete round.pureTrack.error;
    } else {
      round.pureTrack.error = pureTrackError;
    }
    await writePrivateJson(roundPath, RoundSchema, round, leaseId);
    return statusResult(true, previousStatus);
  });
}

export async function commitPureTrackReady(
  roundId: string,
  attemptId: string,
  ownerToken: string,
  result: PureTrackRoundResult | null,
): Promise<{ committed: boolean }> {
  const roundPath = `rounds/${roundId}.json`;
  const committed = await withPrivateLease(roundPath, async (leaseId) => {
    const round: Round = await readJson(
      getPrivateBlobClient(roundPath),
      RoundSchema,
      roundPath,
    );
    if (
      round.pureTrack?.attemptId !== attemptId ||
      round.pureTrack.ownerToken !== ownerToken ||
      round.pureTrack.status !== "processing"
    ) {
      return false;
    }

    clearRoundPureTrackEchoes(round);
    if (result !== null) applyPureTrackResult(round, result);
    round.pureTrack = {
      ...round.pureTrack,
      status: "ready",
      updatedAt: new Date().toISOString(),
    };
    delete round.pureTrack.error;
    await writePrivateJson(roundPath, RoundSchema, round, leaseId);
    return true;
  });
  return { committed };
}

export async function mutatePureTrackEchoes(
  roundId: string,
  mutation: PureTrackEchoMutation,
): Promise<boolean> {
  const roundPath = `rounds/${roundId}.json`;
  const briefPath = `round-briefs/${roundId}.json`;
  await ensureBriefExists(briefPath, roundId);

  return withRoundAndBriefLease(roundId, async (roundLeaseId, briefLeaseId) => {
    const originalRound: Round = await readJson(
      getPrivateBlobClient(roundPath),
      RoundSchema,
      roundPath,
    );
    const originalBrief: RoundBrief = await readJson(
      getPrivateBlobClient(briefPath),
      BriefSchema,
      briefPath,
    );
    const briefClient = getPrivateBlockBlobClient(briefPath);
    const originalBriefBytes = await briefClient.downloadToBuffer();
    const round = structuredClone(originalRound);
    const brief = structuredClone(originalBrief);
    if (!(await mutation({ round, brief }))) return false;

    await writePrivateJson(briefPath, BriefSchema, brief, briefLeaseId);
    try {
      await writePrivateJson(roundPath, RoundSchema, round, roundLeaseId);
    } catch (roundWriteError: unknown) {
      await briefClient.upload(originalBriefBytes, originalBriefBytes.length, {
        blobHTTPHeaders: { blobContentType: "application/json" },
        conditions: { leaseId: briefLeaseId },
      }).catch((rollbackError: unknown) => {
        getTelemetryClient()?.trackEvent({
          name: "puretrack.crossBlobReconcileRequired",
          properties: {
            roundId,
            roundWriteError: errorName(roundWriteError),
            rollbackError: errorName(rollbackError),
          },
        });
      });
      throw roundWriteError;
    }
    return true;
  });
}

export function clearPureTrackEchoes(round: Round, brief: RoundBrief): void {
  clearRoundPureTrackEchoes(round);
  delete brief.pureTrackGroupName;
  delete brief.pureTrackGroupSlug;
  for (const team of brief.teams) {
    delete team.pureTrackGroupId;
    delete team.pureTrackGroupSlug;
  }
}

function clearRoundPureTrackEchoes(round: Round): void {
  delete round.pureTrackGroupId;
  delete round.pureTrackGroupName;
  delete round.pureTrackGroupSlug;
  for (const team of round.teams) {
    delete team.pureTrackGroupId;
    delete team.pureTrackGroupSlug;
  }
}

function applyPureTrackResult(
  round: Round,
  result: PureTrackRoundResult,
): void {
  round.pureTrackGroupId = result.roundGroupId;
  round.pureTrackGroupName = result.roundGroupName;
  round.pureTrackGroupSlug = result.roundGroupSlug;

  for (const teamResult of result.teams) {
    const roundTeam = round.teams.find((team) => team.id === teamResult.teamId);
    if (roundTeam === undefined) continue;
    roundTeam.pureTrackGroupId = teamResult.groupId;
    roundTeam.pureTrackGroupSlug = teamResult.groupSlug;
  }
}

async function ensureBriefExists(briefPath: string, roundId: string): Promise<void> {
  try {
    await writePrivateBlob(
      briefPath,
      {
        roundId,
        generatedAt: new Date().toISOString(),
        date: "1970-01-01",
        siteName: "Pending",
        teams: [],
      },
      undefined,
      { ifNoneMatch: "*" },
    );
  } catch (error: unknown) {
    const statusCode = statusCodeOf(error);
    if (statusCode !== 409 && statusCode !== 412) throw error;
  }
}

function statusResult(
  updated: boolean,
  previousStatus: PureTrackStatus | undefined,
): { updated: boolean; previousStatus?: PureTrackStatus } {
  return previousStatus === undefined ? { updated } : { updated, previousStatus };
}

function isStalePureTrackAttempt(
  updatedAt: string | undefined,
  staleAfterMs: number | undefined,
): boolean {
  if (updatedAt === undefined || staleAfterMs === undefined) return false;
  const updatedAtMs = Date.parse(updatedAt);
  return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs > staleAfterMs;
}

function sanitizePureTrackError(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  if (
    error.length <= MAX_PURETRACK_ERROR_LENGTH &&
    SAFE_PURETRACK_ERROR_CODE.test(error)
  ) {
    return error;
  }
  return REDACTED_ERROR_TEXT;
}

function statusCodeOf(error: unknown): number | undefined {
  if (!(error instanceof Object) || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
