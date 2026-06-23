/**
 * E2E Azurite reset + admin seed.
 *
 * Wipes BOTH blob containers (public `data`, private `data-private`), recreates
 * them, and seeds ONLY the admin user — nothing else. Survives the Azurite
 * delete→recreate race (409 ContainerBeingDeleted) by deleting, polling
 * getProperties() until the container is gone (404 / ContainerNotFound), then
 * recreating with backoff.
 *
 * Reuses the SAME container names (`data`/`data-private`) on purpose: the
 * running Functions host caches ContainerClients by name, so recreating the
 * same names lets the live API serve against fresh containers WITHOUT a restart.
 *
 * Shapes mirror scripts/devtools/seed-qa-users.mjs exactly (admin-only subset).
 */
import {
  BlobServiceClient,
  type ContainerClient,
  RestError,
} from "@azure/storage-blob";
import bcrypt from "bcryptjs";

const CONN =
  process.env.BLOB_CONNECTION_STRING ??
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

const PUBLIC_CONTAINER = process.env.BLOB_CONTAINER_NAME ?? "data";
const PRIVATE_CONTAINER = process.env.BLOB_PRIVATE_CONTAINER_NAME ?? "data-private";

const ADMIN_EMAIL = "qa-admin@example.test";
const ADMIN_PASSWORD = "test1234!";
const A_ID = "11111111-1111-4111-8111-111111111111";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract an HTTP status / Azure error code from any thrown error. */
function errInfo(err: unknown): { status?: number; code?: string } {
  if (err instanceof RestError) {
    return { status: err.statusCode, code: err.code };
  }
  const e = err as { statusCode?: number; code?: string } | null;
  return { status: e?.statusCode, code: e?.code };
}

/**
 * Wipe one container, wait for it to fully disappear, then recreate it.
 *
 * 1. delete() (tolerate 404 = already gone).
 * 2. Poll getProperties() until it 404s (ContainerNotFound) — Azurite reports
 *    the container as still present for a moment after delete returns.
 * 3. create() in a retry loop that tolerates 409 ContainerBeingDeleted with
 *    backoff.
 */
async function resetContainer(
  client: ContainerClient,
  options: { access?: "blob" } | undefined,
): Promise<void> {
  // 1. Delete (tolerate already-absent).
  try {
    await client.delete();
  } catch (err) {
    const { status, code } = errInfo(err);
    if (status !== 404 && code !== "ContainerNotFound") throw err;
  }

  // 2. Poll until gone (getProperties throws 404 / ContainerNotFound).
  const maxPollAttempts = 40;
  let gone = false;
  for (let i = 0; i < maxPollAttempts; i++) {
    try {
      await client.getProperties();
      // Still present (possibly mid-delete) — wait and retry.
      await delay(250);
    } catch (err) {
      const { status, code } = errInfo(err);
      if (status === 404 || code === "ContainerNotFound") {
        gone = true;
        break;
      }
      throw err;
    }
  }
  if (!gone) {
    throw new Error(
      `Container '${client.containerName}' did not disappear after delete within ${maxPollAttempts} polls`,
    );
  }

  // 3. Recreate, tolerating 409 ContainerBeingDeleted with backoff.
  const maxCreateAttempts = 40;
  for (let i = 0; i < maxCreateAttempts; i++) {
    try {
      await client.create(options);
      return;
    } catch (err) {
      const { status, code } = errInfo(err);
      const beingDeleted =
        status === 409 &&
        (code === "ContainerBeingDeleted" || code === "ContainerAlreadyExists");
      if (!beingDeleted) throw err;
      // Backoff: 250ms → cap at 2s.
      await delay(Math.min(250 * (i + 1), 2000));
    }
  }
  throw new Error(
    `Container '${client.containerName}' could not be recreated after ${maxCreateAttempts} attempts (409 ContainerBeingDeleted)`,
  );
}

/** Upload a JSON blob (matches the `put` helper in seed-qa-users.mjs). */
async function putJson(
  client: ContainerClient,
  path: string,
  obj: unknown,
): Promise<void> {
  const body = JSON.stringify(obj, null, 2);
  await client.getBlockBlobClient(path).upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

/**
 * Reset both Azurite containers and seed ONLY the admin user.
 *
 * Leaves `data` existing, public, and EMPTY (zero blobs). Seeds exactly 3
 * blobs into `data-private`: users/{A_ID}.json, auth/{A_ID}.json, user-index.json.
 *
 * @returns the admin credentials for the E2E spec to log in with.
 */
export async function resetAzuriteAndSeedAdmin(): Promise<{
  email: string;
  password: string;
}> {
  const svc = BlobServiceClient.fromConnectionString(CONN);
  const pub = svc.getContainerClient(PUBLIC_CONTAINER);
  const priv = svc.getContainerClient(PRIVATE_CONTAINER);

  // Wipe + recreate both. `data` public (anonymous blob read), `data-private` private.
  await resetContainer(pub, { access: "blob" });
  await resetContainer(priv, undefined);

  // Seed ONLY the admin user (3 blobs in data-private). `data` stays empty.
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 4);
  const now = new Date().toISOString();

  await putJson(priv, `users/${A_ID}.json`, {
    id: A_ID,
    email: ADMIN_EMAIL,
    roles: ["Admin"],
    pilotId: null,
    clubId: null,
    createdAt: now,
  });
  await putJson(priv, `auth/${A_ID}.json`, {
    passwordHash,
    emailVerified: true,
    createdAt: now,
  });
  await putJson(priv, "user-index.json", { [ADMIN_EMAIL]: A_ID });

  return { email: ADMIN_EMAIL, password: ADMIN_PASSWORD };
}
