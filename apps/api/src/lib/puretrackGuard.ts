// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";

import { getPrivateBlockBlobClient } from "./blob.js";

const GLOBAL_GUARD_PATH = "puretrack-jobs/active/global.json";
const STALE_GUARD_MS = 12 * 60 * 1000;

const PureTrackMutationGuardRecordSchema = z.object({
  ownerToken: z.string().min(1),
  attemptId: z.string().min(1),
  acquiredAt: z.string().min(1),
}).strict();

export type PureTrackMutationScope = "global";

export interface PureTrackMutationGuardHandle {
  readonly ownerToken: string;
  readonly etag: string;
  readonly scope: PureTrackMutationScope;
}

class PureTrackGuardOwnershipError extends Error {
  readonly name = "PureTrackGuardOwnershipError";

  constructor(scope: PureTrackMutationScope) {
    super(`PureTrack mutation guard ownership lost for ${scope}`);
  }
}

export async function acquirePureTrackMutationGuard(
  scope: PureTrackMutationScope,
  attemptId: string,
): Promise<PureTrackMutationGuardHandle | null> {
  const path = guardPath(scope);
  const client = getPrivateBlockBlobClient(path);
  const ownerToken = randomUUID();
  const body = guardBody(ownerToken, attemptId);

  try {
    const response = await client.upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { ifNoneMatch: "*" },
    });
    return handleFrom(scope, ownerToken, response.etag);
  } catch (error: unknown) {
    if (!isConflict(error)) throw error;
  }

  let properties;
  try {
    properties = await client.getProperties();
  } catch (error: unknown) {
    if (statusCodeOf(error) !== 404) throw error;
    try {
      const response = await client.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: "application/json" },
        conditions: { ifNoneMatch: "*" },
      });
      return handleFrom(scope, ownerToken, response.etag);
    } catch (retryError: unknown) {
      if (isConflict(retryError)) return null;
      throw retryError;
    }
  }

  const lastModified = properties.lastModified?.getTime();
  const ageMs = lastModified === undefined ? 0 : Date.now() - lastModified;
  if (!Number.isFinite(ageMs) || ageMs < STALE_GUARD_MS || properties.etag === undefined) {
    return null;
  }

  try {
    const response = await client.upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { ifMatch: properties.etag },
    });
    return handleFrom(scope, ownerToken, response.etag);
  } catch (error: unknown) {
    if (isConflict(error)) return null;
    throw error;
  }
}

export async function assertPureTrackGuardOwned(
  handle: PureTrackMutationGuardHandle,
): Promise<void> {
  const client = getPrivateBlockBlobClient(guardPath(handle.scope));
  try {
    const record = PureTrackMutationGuardRecordSchema.parse(
      JSON.parse((await client.downloadToBuffer(
        0,
        undefined,
        { conditions: { ifMatch: handle.etag } },
      )).toString("utf8")),
    );
    if (record.ownerToken !== handle.ownerToken) {
      throw new PureTrackGuardOwnershipError(handle.scope);
    }
  } catch (error: unknown) {
    if (error instanceof PureTrackGuardOwnershipError) throw error;
    if (statusCodeOf(error) === 404 || statusCodeOf(error) === 412) {
      throw new PureTrackGuardOwnershipError(handle.scope);
    }
    throw error;
  }
}

export async function releasePureTrackGuard(
  handle: PureTrackMutationGuardHandle,
): Promise<void> {
  const client = getPrivateBlockBlobClient(guardPath(handle.scope));
  try {
    const record = PureTrackMutationGuardRecordSchema.parse(
      JSON.parse((await client.downloadToBuffer()).toString("utf8")),
    );
    if (record.ownerToken !== handle.ownerToken) return;
    await client.delete({ conditions: { ifMatch: handle.etag } });
  } catch (error: unknown) {
    const statusCode = statusCodeOf(error);
    if (statusCode === 404 || statusCode === 412) return;
    throw error;
  }
}

function guardPath(scope: PureTrackMutationScope): string {
  switch (scope) {
    case "global":
      return GLOBAL_GUARD_PATH;
  }
}

function guardBody(ownerToken: string, attemptId: string): string {
  return JSON.stringify({
    ownerToken,
    attemptId,
    acquiredAt: new Date().toISOString(),
  }, null, 2);
}

function handleFrom(
  scope: PureTrackMutationScope,
  ownerToken: string,
  etag: string | undefined,
): PureTrackMutationGuardHandle {
  if (etag === undefined) throw new Error("PureTrack guard write returned no ETag");
  return { ownerToken, etag, scope };
}

function statusCodeOf(error: unknown): number | undefined {
  if (!(error instanceof Object) || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function isConflict(error: unknown): boolean {
  const statusCode = statusCodeOf(error);
  return statusCode === 409 || statusCode === 412;
}
