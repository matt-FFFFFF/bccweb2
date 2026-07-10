// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * discarded-counts.mjs
 *
 * Manages .migration-state/discarded-counts.json — a record of legacy entity
 * types that were analyzed but NOT migrated to blobs (count-only audit trail).
 *
 * Used by:
 *   migrate.mjs  — writes counts after processing each discarded entity type
 *   reconcile.mjs — reads counts and includes them in the reconciliation report
 *
 * The stateDir parameter defaults to ".migration-state" but can be overridden
 * for testing without touching the real state directory.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_STATE_DIR = ".migration-state";
const FILENAME = "discarded-counts.json";

/**
 * Persist discarded entity counts to the state file (atomic tmp-rename write).
 *
 * @param {Record<string, number>} counts  Entity name → row count that was NOT migrated.
 * @param {string} [stateDir]             Override state directory (used in tests).
 */
export function writeDiscardedCounts(counts, stateDir = DEFAULT_STATE_DIR) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, FILENAME);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(counts, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Read discarded entity counts from the state file.
 * Returns null when the file is absent or unparseable.
 *
 * @param {string} [stateDir]  Override state directory (used in tests).
 * @returns {Record<string, number> | null}
 */
export function readDiscardedCounts(stateDir = DEFAULT_STATE_DIR) {
  const path = join(stateDir, FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
