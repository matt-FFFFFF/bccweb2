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
import {
  withFixtureOperationLock,
  writeJsonDurably,
} from "./fixtureOperation.mjs";

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
  return { version: 3, seedRoundIds: [], seedTarget: null, loadRoundId: null, loadTarget: null };
}

function isRoundId(value) {
  return typeof value === "string" && value.length > 0;
}

export function parseLoadTestRoundState(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LoadTestRoundStateError("load-test round state must be an object");
  }
  if (value.version === 1) {
    if (value.loadRoundId !== null) {
      throw new LoadTestRoundStateError("legacy owned load-test state has no target identity");
    }
    value = { ...value, version: 2, loadTarget: null };
  }
  if (value.version === 2) {
    if (Array.isArray(value.seedRoundIds) && value.seedRoundIds.length > 0) {
      throw new LoadTestRoundStateError("legacy owned seed-round state has no target identity");
    }
    value = { ...value, version: 3, seedTarget: null };
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["loadRoundId", "loadTarget", "seedRoundIds", "seedTarget", "version"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new LoadTestRoundStateError("load-test round state has unexpected keys");
  }
  if (value.version !== 3) {
    throw new LoadTestRoundStateError("load-test round state version must be 3");
  }
  if (!Array.isArray(value.seedRoundIds) || !value.seedRoundIds.every(isRoundId)) {
    throw new LoadTestRoundStateError("seedRoundIds must contain only non-empty strings");
  }
  if (new Set(value.seedRoundIds).size !== value.seedRoundIds.length) {
    throw new LoadTestRoundStateError("seedRoundIds must be unique");
  }
  const validSeedTarget = typeof value.seedTarget === "string" && /^[a-f0-9]{64}$/u.test(value.seedTarget);
  if ((value.seedRoundIds.length === 0) !== (value.seedTarget === null) || (value.seedTarget !== null && !validSeedTarget)) {
    throw new LoadTestRoundStateError("seedTarget must be a SHA-256 identity paired with seedRoundIds");
  }
  if (value.loadRoundId !== null && !isRoundId(value.loadRoundId)) {
    throw new LoadTestRoundStateError("loadRoundId must be null or a non-empty string");
  }
  const validTarget = typeof value.loadTarget === "string" && /^[a-f0-9]{64}$/u.test(value.loadTarget);
  if ((value.loadRoundId === null) !== (value.loadTarget === null) || (value.loadTarget !== null && !validTarget)) {
    throw new LoadTestRoundStateError("loadTarget must be a SHA-256 identity paired with loadRoundId");
  }
  return {
    version: 3,
    seedRoundIds: [...value.seedRoundIds],
    seedTarget: value.seedTarget,
    loadRoundId: value.loadRoundId,
    loadTarget: value.loadTarget,
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
  if (files === DEFAULT_FILES && mode === PRIVATE_FILE_MODE) {
    await writeJsonDurably(path, value);
    return;
  }
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
  const path = options?.path ?? LOADTEST_ROUND_STATE_PATH;
  return withFixtureOperationLock(async () => {
    const state = await readLoadTestRoundState(options);
    const next = parseLoadTestRoundState(update(state));
    await writeJsonAtomically(path, next, options);
    return next;
  }, { path: `${path}.lock` });
}

export function replaceSeedRoundIds(seedRoundIds, seedTarget, options = {}) {
  return updateState((state) => {
    assertSeedRoundTarget(state, seedTarget);
    return {
      ...state,
      seedRoundIds: [...seedRoundIds],
      seedTarget: seedRoundIds.length === 0 ? null : seedTarget,
    };
  }, options);
}

export function appendSeedRoundId(seedRoundId, seedTarget, options = {}) {
  return updateState((state) => {
    assertSeedRoundTarget(state, seedTarget);
    return {
      ...state,
      seedRoundIds: state.seedRoundIds.includes(seedRoundId)
        ? state.seedRoundIds
        : [...state.seedRoundIds, seedRoundId],
      seedTarget,
    };
  }, options);
}

export function setLoadRoundId(loadRoundId, loadTarget, options = {}) {
  return updateState((state) => ({
    ...state,
    loadRoundId,
    loadTarget: loadRoundId === null ? null : loadTarget,
  }), options);
}

export function assertLoadRoundTarget(state, expectedTarget) {
  if (state.loadRoundId !== null && state.loadTarget !== expectedTarget) {
    throw new LoadTestRoundStateError("checkpointed load round belongs to a different target stack");
  }
}

export function assertSeedRoundTarget(state, expectedTarget) {
  if (state.seedRoundIds.length > 0 && state.seedTarget !== expectedTarget) {
    throw new LoadTestRoundStateError("checkpointed seed rounds belong to a different target stack");
  }
}
