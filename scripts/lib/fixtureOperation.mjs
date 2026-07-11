// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const FIXTURE_LOCK_PATH = ".fixture-operation.lock";
export const FIXTURE_CLEANUP_STATE_PATH = ".fixture-cleanup-state.json";
const MODE = 0o600;
const DIRECTORY_MODE = 0o700;

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function writeJsonDurably(path, value) {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(tempPath, "wx", MODE);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
    await file.chmod(MODE);
    await file.close();
    file = undefined;
    await rename(tempPath, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (file) await file.close();
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function readCleanupState(path = FIXTURE_CLEANUP_STATE_PATH) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function prepareLock(path) {
  const token = randomUUID();
  const ownerName = `owner-${token}.json`;
  const candidatePath = join(dirname(path), `.${basename(path)}.${token}.candidate`);
  await mkdir(candidatePath, { mode: DIRECTORY_MODE });
  const owner = await open(join(candidatePath, ownerName), "wx", MODE);
  try {
    await owner.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");
    await owner.sync();
  } finally {
    await owner.close();
  }
  return { candidatePath, ownerName };
}

async function observedOwner(path) {
  let names;
  try {
    names = await readdir(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ENOTDIR") return undefined;
    throw error;
  }
  if (names.length !== 1 || !names[0].startsWith("owner-") || !names[0].endsWith(".json")) {
    return undefined;
  }
  const ownerName = names[0];
  try {
    const owner = JSON.parse(await readFile(join(path, ownerName), "utf8"));
    const token = ownerName.slice("owner-".length, -".json".length);
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || owner?.token !== token) return undefined;
    return { pid: owner.pid, ownerName };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function removeOwnedLock(path, ownerName) {
  try {
    await unlink(join(path, ownerName));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTEMPTY" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

export async function withFixtureOperationLock(run, options = {}) {
  const path = options.path ?? FIXTURE_LOCK_PATH;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const beforeStaleUnlink = options.beforeStaleUnlink ?? (() => undefined);
  const beforeReleaseUnlink = options.beforeReleaseUnlink ?? (() => undefined);
  const startedAt = Date.now();
  const lock = await prepareLock(path);
  let acquired = false;
  try {
    while (!acquired) {
      try {
        await rename(lock.candidatePath, path);
        acquired = true;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EISDIR", "ENOTDIR"].includes(error?.code)) throw error;
        const owner = await observedOwner(path);
        if (owner) {
          try {
            process.kill(owner.pid, 0);
          } catch (ownerError) {
            if (ownerError?.code === "ESRCH") {
              await beforeStaleUnlink();
              await removeOwnedLock(path, owner.ownerName);
              continue;
            }
            if (ownerError?.code !== "EPERM") throw ownerError;
          }
        } else if (owner === null) {
          continue;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(`fixture operation lock timeout: ${path}`, { cause: error });
        }
        await pause(25);
      }
    }
    try {
      return await run();
    } finally {
      await beforeReleaseUnlink();
      await removeOwnedLock(path, lock.ownerName);
    }
  } finally {
    await rm(lock.candidatePath, { recursive: true, force: true });
  }
}
