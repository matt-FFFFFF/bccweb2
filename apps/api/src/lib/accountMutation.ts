import type { User } from "@bccweb/types";
import { UserSchema } from "@bccweb/schemas";
import * as z from "zod/v4";
import {
  ensurePrivateJsonIndexBlob,
  getPrivateBlobClient,
  withPrivateLeaseRenewing,
} from "./blob.js";
import { readJson } from "./blobJson.js";
import { HttpError } from "./http.js";

const ACCOUNT_MUTATION_LOCK_PATH = "users/.admin-mutation.lock";
const MAX_LOCK_ACQUIRE_ATTEMPTS = 20;
const StringRecordSchema = z.record(z.string(), z.string());

export class UserDeletedError extends Error {
  readonly userId: string;

  constructor(userId: string) {
    super(`User ${userId} has been deleted`);
    this.name = "UserDeletedError";
    this.userId = userId;
  }
}

export async function withAccountMutationLock<T>(
  fn: (leaseId: string) => Promise<T>,
): Promise<T> {
  await ensurePrivateJsonIndexBlob(ACCOUNT_MUTATION_LOCK_PATH, "{}");

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      return await withPrivateLeaseRenewing(ACCOUNT_MUTATION_LOCK_PATH, fn);
    } catch (err: unknown) {
      const statusCode = statusCodeOf(err);
      if (statusCode !== 409 && statusCode !== 412) throw err;
      lastErr = err;
      if (attempt < MAX_LOCK_ACQUIRE_ATTEMPTS) {
        await sleep(25 * attempt);
      }
    }
  }

  throw lastErr;
}

export async function isUserDeleted(userId: string): Promise<boolean> {
  try {
    return await getPrivateBlobClient(deletedUserPath(userId)).exists();
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) return false;
    return true;
  }
}

export async function assertNotLastAdmin(
  excludeUserId: string,
  nextRoles?: readonly User["roles"][number][],
): Promise<void> {
  const replacementKeepsAdmin = nextRoles?.includes("Admin") ?? false;
  if (replacementKeepsAdmin && !(await isUserDeleted(excludeUserId))) return;

  const index = await readUserIndex();
  const userIds = new Set(Object.values(index));
  let liveAdminCount = 0;

  for (const userId of userIds) {
    if (userId === excludeUserId) continue;
    if (await isUserDeleted(userId)) continue;

    const user = await readUser(userId);
    if (user?.roles.includes("Admin")) liveAdminCount += 1;
    if (liveAdminCount > 0) return;
  }

  throw new HttpError(409, "LAST_ADMIN", "Cannot remove the last live admin");
}

function deletedUserPath(userId: string): string {
  return `users/deleted/${userId}.json`;
}

async function readUserIndex(): Promise<Record<string, string>> {
  try {
    return await readJson(
      getPrivateBlobClient("user-index.json"),
      StringRecordSchema,
      "user-index.json",
    );
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) return {};
    throw err;
  }
}

async function readUser(userId: string): Promise<User | null> {
  const userPath = `users/${userId}.json`;
  try {
    return await readJson(getPrivateBlobClient(userPath), UserSchema, userPath);
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) return null;
    throw err;
  }
}

function statusCodeOf(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
