// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import {
  chmod,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const LOADTEST_ROUND_STATE_PATH = ".loadtest-round-state.json";
const PRIVATE_FILE_MODE = 0o600;

const DEFAULT_FILES = { chmod, readFile, rename, unlink, writeFile };

export class LoadTestRoundStateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "LoadTestRoundStateError";
  }
}

function emptyState() {
  return { version: 1, seedRoundIds: [], loadRoundId: null };
}

function isRoundId(value) {
  return typeof value === "string" && value.length > 0;
}

export function parseLoadTestRoundState(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LoadTestRoundStateError("load-test round state must be an object");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["loadRoundId", "seedRoundIds", "version"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new LoadTestRoundStateError("load-test round state has unexpected keys");
  }
  if (value.version !== 1) {
    throw new LoadTestRoundStateError("load-test round state version must be 1");
  }
  if (!Array.isArray(value.seedRoundIds) || !value.seedRoundIds.every(isRoundId)) {
    throw new LoadTestRoundStateError("seedRoundIds must contain only non-empty strings");
  }
  if (new Set(value.seedRoundIds).size !== value.seedRoundIds.length) {
    throw new LoadTestRoundStateError("seedRoundIds must be unique");
  }
  if (value.loadRoundId !== null && !isRoundId(value.loadRoundId)) {
    throw new LoadTestRoundStateError("loadRoundId must be null or a non-empty string");
  }
  return {
    version: 1,
    seedRoundIds: [...value.seedRoundIds],
    loadRoundId: value.loadRoundId,
  };
}

export async function readLoadTestRoundState(options = {}) {
  const { path = LOADTEST_ROUND_STATE_PATH, files = DEFAULT_FILES } = options;
  let contents;
  try {
    contents = await files.readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
  try {
    return parseLoadTestRoundState(JSON.parse(contents));
  } catch (error) {
    if (error instanceof LoadTestRoundStateError) throw error;
    throw new LoadTestRoundStateError(`invalid JSON in ${path}`, { cause: error });
  }
}

export async function writeJsonAtomically(path, value, options = {}) {
  const { files = DEFAULT_FILES, mode = PRIVATE_FILE_MODE } = options;
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await files.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await files.chmod(tempPath, mode);
    await files.rename(tempPath, path);
  } catch (error) {
    try {
      await files.unlink(tempPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          `failed to write and clean ${path}`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}

async function updateState(update, options) {
  const state = await readLoadTestRoundState(options);
  const next = parseLoadTestRoundState(update(state));
  await writeJsonAtomically(options?.path ?? LOADTEST_ROUND_STATE_PATH, next, options);
  return next;
}

export function replaceSeedRoundIds(seedRoundIds, options = {}) {
  return updateState((state) => ({ ...state, seedRoundIds: [...seedRoundIds] }), options);
}

export function appendSeedRoundId(seedRoundId, options = {}) {
  return updateState((state) => ({
    ...state,
    seedRoundIds: state.seedRoundIds.includes(seedRoundId)
      ? state.seedRoundIds
      : [...state.seedRoundIds, seedRoundId],
  }), options);
}

export function setLoadRoundId(loadRoundId, options = {}) {
  return updateState((state) => ({ ...state, loadRoundId }), options);
}
