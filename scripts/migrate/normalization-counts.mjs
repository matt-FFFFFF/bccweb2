// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * normalization-counts.mjs
 *
 * Manages .migration-state/normalization-counts.json — a deterministic audit
 * trail of legacy enum normalization and schema drift fixes applied during the
 * SQL → Blob migration.
 *
 * Used by:
 *   migrate.mjs  — writes counts after migration processing completes
 *   reconcile.mjs — reads counts and includes them in the reconciliation report
 *
 * The stateDir parameter defaults to ".migration-state" but can be overridden
 * for testing without touching the real state directory.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_STATE_DIR = ".migration-state";
const FILENAME = "normalization-counts.json";

/**
 * Persist normalization counts to the state file (atomic tmp-rename write).
 *
 * @param {object} counts       Normalization/drift-fix count payload.
 * @param {string} [stateDir]   Override state directory (used in tests).
 */
export function writeNormalizationCounts(counts, stateDir = DEFAULT_STATE_DIR) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, FILENAME);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(counts, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Read normalization counts from the state file.
 * Returns null when the file is absent or unparseable.
 *
 * @param {string} [stateDir]  Override state directory (used in tests).
 * @returns {object | null}
 */
export function readNormalizationCounts(stateDir = DEFAULT_STATE_DIR) {
  const path = join(stateDir, FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
