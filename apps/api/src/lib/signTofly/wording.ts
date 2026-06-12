import { createHash } from "node:crypto";
import type { SignToFlyWording } from "@bccweb/types";
import { ActiveWordingPointerSchema, SignToFlyWordingSchema } from "@bccweb/schemas";
import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  withPrivateLease,
} from "../blob.js";
import { readJson } from "../blobJson.js";
import { HttpError } from "../http.js";

export interface ActiveWording {
  activeVersion: number;
}

const ACTIVE_WORDING_PATH = "sign-to-fly/wording/active.json";

export async function getActiveWording(): Promise<SignToFlyWording> {
  const active = await readActiveWordingPointer();
  return getWording(active.activeVersion);
}

export async function getWording(version: number): Promise<SignToFlyWording> {
  const path = wordingVersionPath(version);
  try {
    return await readJson(
      getPrivateBlobClient(path),
      SignToFlyWordingSchema,
      path,
    );
  } catch (err: unknown) {
    if (isMissingBlob(err)) {
      throw new HttpError(404, "WORDING_VERSION_NOT_FOUND");
    }
    throw err;
  }
}

export async function addWordingVersion(opts: {
  html: string;
  plainText: string;
  createdBy: string;
}): Promise<SignToFlyWording> {
  return withPrivateLease(ACTIVE_WORDING_PATH, async (leaseId) => {
    const active = await readActiveWordingPointer();
    const current = await getWording(active.activeVersion);
    const now = new Date().toISOString();
    const newVersion = current.version + 1;
    const next: SignToFlyWording = {
      version: newVersion,
      hash: hashHtml(opts.html),
      html: opts.html,
      plainText: opts.plainText,
      createdAt: now,
      createdBy: opts.createdBy,
    };

    await uploadNewJson(wordingVersionPath(newVersion), next);
    await uploadJsonIfMatch(
      wordingVersionPath(current.version),
      {
        ...current,
        supersededAt: now,
        supersededBy: newVersion,
      },
      await getEtag(wordingVersionPath(current.version)),
    );
    await uploadJsonIfMatch(
      ACTIVE_WORDING_PATH,
      { activeVersion: newVersion } satisfies ActiveWording,
      await getEtag(ACTIVE_WORDING_PATH),
      leaseId,
    );

    return next;
  });
}

function hashHtml(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}

async function readActiveWordingPointer(): Promise<ActiveWording> {
  try {
    return await readJson(
      getPrivateBlobClient(ACTIVE_WORDING_PATH),
      ActiveWordingPointerSchema,
      ACTIVE_WORDING_PATH,
    );
  } catch (err: unknown) {
    if (isMissingBlob(err)) {
      throw new HttpError(503, "WORDING_NOT_SEEDED");
    }
    throw err;
  }
}

async function getEtag(path: string): Promise<string> {
  const props = await getPrivateBlobClient(path).getProperties();
  if (!props.etag) {
    throw new Error(`Missing ETag for ${path}`);
  }
  return props.etag;
}

async function uploadNewJson(path: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await getPrivateBlockBlobClient(path).upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    conditions: { ifNoneMatch: "*" },
  });
}

async function uploadJsonIfMatch(
  path: string,
  data: unknown,
  ifMatch: string,
  leaseId?: string,
): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await getPrivateBlockBlobClient(path).upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    conditions: { ifMatch, ...(leaseId ? { leaseId } : {}) },
  });
}

function wordingVersionPath(version: number): string {
  return `sign-to-fly/wording/${version}.json`;
}

function isMissingBlob(err: unknown): boolean {
  return (err as { statusCode?: number }).statusCode === 404;
}
