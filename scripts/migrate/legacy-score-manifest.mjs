/**
 * legacy-score-manifest.mjs
 *
 * Manages .migration-state/legacy-score-manifest.json — the migration's own
 * record of the LEGACY scores it preserved verbatim for every Complete round.
 *
 * Migrated Complete rounds keep their exact persisted legacy scores; the new
 * scoring engine NEVER re-scores them (re-scoring could shift historical
 * results — plan D5 / Oracle O9). This manifest lets validate.mjs prove the
 * migrated blobs still equal the legacy values.
 *
 * Shape (keyed by LEGACY ids so validate.mjs can match migrated blobs back by
 * (round.legacyId, team.legacyId, slot.placeInTeam)):
 *
 *   { [roundLegacyId]: { [roundTeamLegacyId]: {
 *       teamScore: number,                       // legacy RoundTeam.TeamScore
 *       pilots: { [placeInTeam]: pilotPoints }   // legacy RoundTeamPilot.PilotPoints
 *   } } }
 *
 * This is DISTINCT from W2.0's scoring-oracle fixture manifest under
 * packages/scoring (different keys + purpose): this one proves migrated ==
 * legacy; that one is the numeric-fidelity oracle for the NEW engine. Do not
 * conflate or overwrite the two.
 *
 * Used by:
 *   migrate.mjs   — writes the manifest as it preserves each Complete round's scores
 *   validate.mjs  — reads it and asserts migrated team.score / slot.pilotPoints == legacy
 *
 * The stateDir parameter defaults to ".migration-state" but can be overridden
 * for testing without touching the real state directory.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_STATE_DIR = ".migration-state";
const FILENAME = "legacy-score-manifest.json";

/**
 * The shared on-disk path for the legacy-score manifest (state-dir relative),
 * so migrate.mjs and validate.mjs never drift on where it lives.
 *
 * @param {string} [stateDir]  Override state directory (used in tests).
 * @returns {string}
 */
export function legacyScoreManifestPath(stateDir = DEFAULT_STATE_DIR) {
  return join(stateDir, FILENAME);
}

/**
 * Persist the legacy-score manifest to the state file (atomic tmp-rename write).
 *
 * @param {Record<string, Record<string, {teamScore:number, pilots:Record<string, number>}>>} manifest
 * @param {string} [stateDir]  Override state directory (used in tests).
 */
export function writeLegacyScoreManifest(manifest, stateDir = DEFAULT_STATE_DIR) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, FILENAME);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Read the legacy-score manifest from the state file.
 * Returns null when the file is absent or unparseable.
 *
 * @param {string} [stateDir]  Override state directory (used in tests).
 * @returns {Record<string, Record<string, {teamScore:number, pilots:Record<string, number>}>> | null}
 */
export function readLegacyScoreManifest(stateDir = DEFAULT_STATE_DIR) {
  const path = join(stateDir, FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
