// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const FIXTURE_LOCK_PATH = ".fixture-operation.lock";
export const FIXTURE_CLEANUP_STATE_PATH = ".fixture-cleanup-state.json";
const MODE = 0o600;

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

export async function withFixtureOperationLock(run, options = {}) {
  const path = options.path ?? FIXTURE_LOCK_PATH;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  let lock;
  while (!lock) {
    try {
      lock = await open(path, "wx", MODE);
      await lock.writeFile(`${process.pid}\n`);
      await lock.sync();
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = Number.NaN;
      try {
        owner = Number.parseInt(await readFile(path, "utf8"), 10);
        process.kill(owner, 0);
      } catch (ownerError) {
        if (ownerError?.code === "ESRCH" || ownerError?.code === "ENOENT" || Number.isNaN(owner)) {
          await rm(path, { force: true });
          continue;
        }
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
    await lock.close();
    await rm(path, { force: true });
  }
}
