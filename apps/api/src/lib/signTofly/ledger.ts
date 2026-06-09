import type { Signature } from "@bccweb/types";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  readBlob,
} from "../blob.js";

let privateContainer: ContainerClient | null = null;

export function signaturePath(
  roundId: string,
  teamId: string,
  place: number,
  briefVersion: number,
): string {
  return `${latestSignaturePathPattern(roundId, teamId, place)}v${briefVersion}.json`;
}

export function legacySignaturePath(
  roundId: string,
  teamId: string,
  place: number,
): string {
  return `${latestSignaturePathPattern(roundId, teamId, place)}vlegacy.json`;
}

export function latestSignaturePathPattern(
  roundId: string,
  teamId: string,
  place: number,
): string {
  return `signatures/${roundId}/${teamId}-${place}-`;
}

export async function readSignature(
  roundId: string,
  teamId: string,
  place: number,
  briefVersion: number,
): Promise<Signature | null> {
  try {
    return await readBlob<Signature>(
      getPrivateBlobClient(signaturePath(roundId, teamId, place, briefVersion)),
    );
  } catch (err: unknown) {
    if (isMissingBlob(err)) return null;
    throw err;
  }
}

export async function listSignaturesForRound(roundId: string): Promise<Signature[]> {
  const prefix = `signatures/${roundId}/`;
  const signatures: Signature[] = [];

  for await (const item of getPrivateContainer().listBlobsFlat({ prefix })) {
    signatures.push(await readBlob<Signature>(getPrivateBlobClient(item.name)));
  }

  return signatures;
}

export async function getLatestSignature(
  roundId: string,
  teamId: string,
  place: number,
): Promise<Signature | null> {
  const prefix = latestSignaturePathPattern(roundId, teamId, place);
  let latest: Signature | null = null;

  for await (const item of getPrivateContainer().listBlobsFlat({ prefix })) {
    const version = briefVersionFromPath(item.name);
    if (version === null) continue;
    if (latest?.briefVersion !== null && latest?.briefVersion !== undefined && latest.briefVersion >= version) {
      continue;
    }
    latest = await readBlob<Signature>(getPrivateBlobClient(item.name));
  }

  return latest;
}

export async function writeSignature(sig: Signature): Promise<void> {
  const path = sig.briefVersion === null
    ? legacySignaturePath(sig.roundId, sig.teamId, sig.place)
    : signaturePath(sig.roundId, sig.teamId, sig.place, sig.briefVersion);
  const content = JSON.stringify(sig, null, 2);

  try {
    await getPrivateBlockBlobClient(path).uploadData(Buffer.from(content), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { ifNoneMatch: "*" },
    });
  } catch (err: unknown) {
    if (isPreconditionFailed(err)) return;
    throw err;
  }
}

function briefVersionFromPath(path: string): number | null {
  const match = /-v(\d+)\.json$/.exec(path);
  if (!match) return null;
  return Number(match[1]);
}

function isMissingBlob(err: unknown): boolean {
  return (err as { statusCode?: number }).statusCode === 404;
}

function isPreconditionFailed(err: unknown): boolean {
  const storageErr = err as { statusCode?: number; code?: string };
  return storageErr.statusCode === 412 || storageErr.statusCode === 409 || storageErr.code === "BlobAlreadyExists";
}

function getPrivateContainer(): ContainerClient {
  if (privateContainer) return privateContainer;
  const connectionString = process.env["BLOB_CONNECTION_STRING"];
  if (!connectionString) {
    throw new Error("BLOB_CONNECTION_STRING environment variable is not set");
  }
  privateContainer = BlobServiceClient
    .fromConnectionString(connectionString)
    .getContainerClient(process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private");
  return privateContainer;
}
