// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { app, type InvocationContext } from "@azure/functions";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { RoundSchema } from "@bccweb/schemas";
import * as z from "zod/v4";

import { getPrivateBlobClient } from "../lib/blob.js";
import { readJson } from "../lib/blobJson.js";
import { acquirePureTrackMutationGuard, assertPureTrackGuardOwned, releasePureTrackGuard, renewPureTrackGuard, type PureTrackMutationGuardHandle } from "../lib/puretrackGuard.js";
import { authenticate, createPureTrackGroups, deleteGroups, isPureTrackEnabled, listMyGroups, loadPilotPureTrackIds, PureTrackCreateResponseError, PureTrackDeleteError, PureTrackGroupOperationError, type BeforePureTrackOutbound, type PureTrackRoundResult, type PureTrackSession } from "../lib/puretrack.js";
import { commitPureTrackReady, mutatePureTrackEchoes, setPureTrackStatus } from "../lib/puretrackStatus.js";
import { enqueuePureTrackGroupJob, PureTrackGroupJobSchema, type PureTrackGroupJob } from "../lib/queue.js";
import { getTelemetryClient } from "../lib/telemetry.js";
import { redactObject } from "../lib/telemetryRedactor.js";

const MAX_DEQUEUE = 5;
const FINAL_FAILURE_STATUSES = ["pending", "processing"] as const;
const PureTrackRecordSchema = z.looseObject({
  roundId: z.string(),
  externalId: z.string().regex(/^\d+$/),
});

type QueueMessage = unknown;
type RecordedGroup = { readonly path: string; readonly externalId: number };
type ActiveJob = {
  readonly job: PureTrackGroupJob;
  readonly session: PureTrackSession;
  readonly beforeOutbound: BeforePureTrackOutbound;
  readonly beforeCleanup: BeforePureTrackOutbound;
};
type RenewableGuard = { handle: PureTrackMutationGuardHandle };

class PureTrackGuardContendedError extends Error {
  readonly name = "PureTrackGuardContendedError";
  constructor() { super("PureTrack global mutation guard is owned by another worker"); }
}

class PureTrackAttemptSupersededError extends Error {
  readonly name = "PureTrackAttemptSupersededError";
  constructor() { super("PureTrack group attempt was superseded"); }
}

function parseQueueMessage(message: QueueMessage): PureTrackGroupJob {
  const raw: unknown = typeof message === "string" ? JSON.parse(message) : message;
  return PureTrackGroupJobSchema.parse(raw);
}

async function readRound(roundId: string) {
  const path = `rounds/${roundId}.json`;
  return readJson(getPrivateBlobClient(path), RoundSchema, path);
}

function getPrivateContainer(): ContainerClient {
  const connectionString = process.env["BLOB_CONNECTION_STRING"];
  if (!connectionString) throw new Error("BLOB_CONNECTION_STRING is not set");
  const containerName = process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private";
  return BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
}

async function listRecordedGroups(roundId: string): Promise<readonly RecordedGroup[]> {
  const container = getPrivateContainer();
  const records: RecordedGroup[] = [];
  for await (const item of container.listBlobsFlat({ prefix: "puretrack-groups/" })) {
    if (!item.name.endsWith(".json")) continue;
    try {
      const parsed = PureTrackRecordSchema.safeParse(
        JSON.parse((await container.getBlockBlobClient(item.name).downloadToBuffer()).toString("utf8")),
      );
      if (!parsed.success || parsed.data.roundId !== roundId) continue;
      const externalId = Number(parsed.data.externalId);
      if (Number.isSafeInteger(externalId) && externalId > 0) {
        records.push({ path: item.name, externalId });
      }
    } catch (error: unknown) {
      if (statusCodeOf(error) !== 404) throw error;
    }
  }
  return records;
}

function echoedGroupIds(round: Awaited<ReturnType<typeof readRound>>): readonly number[] {
  return [
    round.pureTrackGroupId,
    ...round.teams.map((team) => team.pureTrackGroupId),
  ].filter((id): id is number => Number.isSafeInteger(id) && id !== undefined && id > 0);
}

async function clearDeletedGroups(roundId: string, attemptId: string, ids: readonly number[]): Promise<void> {
  const deletedIds = new Set(ids);
  if (deletedIds.size === 0) return;
  await mutatePureTrackEchoes(roundId, ({ round, brief }) => {
    if (round.pureTrack?.attemptId !== attemptId) return false;
    if (round.pureTrackGroupId !== undefined && deletedIds.has(round.pureTrackGroupId)) {
      delete round.pureTrackGroupId;
      delete round.pureTrackGroupName;
      delete round.pureTrackGroupSlug;
      delete brief.pureTrackGroupName;
      delete brief.pureTrackGroupSlug;
    }
    for (const team of round.teams) {
      if (team.pureTrackGroupId === undefined || !deletedIds.has(team.pureTrackGroupId)) continue;
      const teamGroupId = team.pureTrackGroupId;
      delete team.pureTrackGroupId;
      delete team.pureTrackGroupSlug;
      for (const briefTeam of brief.teams) {
        if (briefTeam.pureTrackGroupId !== teamGroupId) continue;
        delete briefTeam.pureTrackGroupId;
        delete briefTeam.pureTrackGroupSlug;
      }
    }
    return true;
  });
  const records = await listRecordedGroups(roundId);
  await Promise.all(records
    .filter((record) => deletedIds.has(record.externalId))
    .map((record) => getPrivateContainer().getBlobClient(record.path).deleteIfExists()));
}

async function deleteAuthoritativeGroups(active: ActiveJob): Promise<void> {
  const round = await readRound(active.job.roundId);
  const records = await listRecordedGroups(active.job.roundId);
  const authoritativeIds = [...new Set([...echoedGroupIds(round), ...records.map((record) => record.externalId)])];
  const liveIds = new Set((await listMyGroups(active.session, active.beforeOutbound)).map((group) => group.id));
  const idsToDelete = authoritativeIds.filter((id) => liveIds.has(id));
  const alreadyGoneIds = authoritativeIds.filter((id) => !liveIds.has(id));
  try {
    await deleteGroups(active.session, idsToDelete, active.beforeOutbound);
    await clearDeletedGroups(active.job.roundId, active.job.attemptId, authoritativeIds);
  } catch (error: unknown) {
    if (error instanceof PureTrackDeleteError) {
      await clearDeletedGroups(active.job.roundId, active.job.attemptId, [
        ...alreadyGoneIds,
        ...error.deletedIds,
        ...error.alreadyGoneIds,
      ]);
    }
    throw error;
  }
}

async function cleanupInvocationGroups(active: ActiveJob, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await deleteGroups(active.session, [...ids], active.beforeCleanup);
    await clearDeletedGroups(active.job.roundId, active.job.attemptId, ids);
  } catch (error: unknown) {
    if (error instanceof PureTrackDeleteError) {
      await clearDeletedGroups(active.job.roundId, active.job.attemptId, [
        ...error.deletedIds,
        ...error.alreadyGoneIds,
      ]);
    }
    throw error;
  }
}

async function processEnabledJob(job: PureTrackGroupJob, guard: RenewableGuard): Promise<void> {
  const beforeOutbound: BeforePureTrackOutbound = async () => {
    await assertPureTrackGuardOwned(guard.handle);
    if ((await readRound(job.roundId)).pureTrack?.attemptId !== job.attemptId) {
      throw new PureTrackAttemptSupersededError();
    }
  };
  const session = await authenticate(beforeOutbound);
  const beforeCleanup: BeforePureTrackOutbound = () => assertPureTrackGuardOwned(guard.handle);
  const active = { job, session, beforeOutbound, beforeCleanup } satisfies ActiveJob;
  await deleteAuthoritativeGroups(active);
  guard.handle = await renewPureTrackGuard(guard.handle);
  const round = await readRound(job.roundId);
  const pilotIds = await loadPilotPureTrackIds(round);
  let result: PureTrackRoundResult | null;
  try {
    result = await createPureTrackGroups(round, pilotIds, { beforeOutbound, session });
  } catch (error: unknown) {
    const ids = error instanceof PureTrackGroupOperationError
      ? error.cleanupIds
      : error instanceof PureTrackCreateResponseError && error.cleanupId !== undefined
        ? [error.cleanupId]
        : [];
    await cleanupInvocationGroups(active, ids);
    throw error;
  }
  guard.handle = await renewPureTrackGuard(guard.handle);
  const { committed } = await commitPureTrackReady(job.roundId, job.attemptId, guard.handle.ownerToken, result);
  if (!committed && result !== null) {
    await cleanupInvocationGroups(active, [
      result.roundGroupId,
      ...result.teams.map((team) => team.groupId),
    ]);
  }
}

export async function handlePureTrackGroupJob(message: QueueMessage, ctx: InvocationContext): Promise<void> {
  const job = parseQueueMessage(message);
  const dequeueCount = Number(ctx.triggerMetadata?.["dequeueCount"] ?? 1);
  const initialRound = await readRound(job.roundId);
  if (initialRound.pureTrack?.attemptId !== job.attemptId) return;
  if (initialRound.pureTrack.status === "ready") return;

  const handle = await acquirePureTrackMutationGuard("global", job.attemptId);
  if (handle === null) {
    if (dequeueCount < MAX_DEQUEUE) throw new PureTrackGuardContendedError();
    await enqueuePureTrackGroupJob(job, { visibilityTimeoutSeconds: 30 });
    return;
  }
  const guard: RenewableGuard = { handle };

  try {
    const currentRound = await readRound(job.roundId);
    if (currentRound.pureTrack?.attemptId !== job.attemptId) return;
    const { updated } = await setPureTrackStatus(job.roundId, "processing", {
      expectAttemptId: job.attemptId,
      fromStatuses: ["pending", "processing"],
      newOwnerToken: guard.handle.ownerToken,
    });
    if (!updated) return;
    if (!isPureTrackEnabled()) {
      await setPureTrackStatus(job.roundId, "ready", {
        expectAttemptId: job.attemptId,
        expectOwnerToken: guard.handle.ownerToken,
        fromStatuses: ["processing"],
      });
      return;
    }
    await processEnabledJob(job, guard);
  } catch (error: unknown) {
    if (dequeueCount < MAX_DEQUEUE) {
      await setPureTrackStatus(job.roundId, "pending", {
        expectAttemptId: job.attemptId,
        expectOwnerToken: guard.handle.ownerToken,
        fromStatuses: ["processing"],
      });
      throw error;
    }
    await setPureTrackStatus(job.roundId, "failed", {
      error: errorCode(error),
      expectAttemptId: job.attemptId,
      expectOwnerToken: guard.handle.ownerToken,
      fromStatuses: FINAL_FAILURE_STATUSES,
    });
  } finally {
    await releasePureTrackGuard(guard.handle);
  }
}

export async function handlePureTrackGroupPoison(message: QueueMessage): Promise<void> {
  try {
    const { roundId, attemptId } = parseQueueMessage(message);
    await setPureTrackStatus(roundId, "failed", {
      error: "poison",
      expectAttemptId: attemptId,
      fromStatuses: FINAL_FAILURE_STATUSES,
    });
  } catch (error: unknown) { // no-excuse-ok: catch — malformed poison must be acknowledged.
    getTelemetryClient()?.trackEvent({
      name: "puretrack.poisonUnparseable",
      properties: redactObject({ error: errorCode(error) }) as Record<string, unknown>,
    });
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  return "PureTrackGroupOperationFailed";
}

function statusCodeOf(error: unknown): number | undefined {
  if (!(error instanceof Object) || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

app.storageQueue("pureTrackGroups", { queueName: "round-puretrack-group", connection: "AzureWebJobsStorage", handler: handlePureTrackGroupJob });
app.storageQueue("pureTrackGroupsPoison", { queueName: "round-puretrack-group-poison", connection: "AzureWebJobsStorage", handler: handlePureTrackGroupPoison });
