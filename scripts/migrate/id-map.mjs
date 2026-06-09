#!/usr/bin/env node
/**
 * id-map.mjs
 *
 * Persistent SQL-ID -> UUID mapping for idempotent migration runs.
 *
 * The map is stored at .migration-state/id-map.json, keyed by
 * "${entity}:${sqlId}" (e.g. "club:42" -> "550e8400-...").
 *
 * Atomic writes: content is written to id-map.json.tmp then renamed,
 * so a crash mid-write never corrupts the map.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const STATE_DIR = ".migration-state";
const MAP_PATH = join(STATE_DIR, "id-map.json");
const TMP_PATH = `${MAP_PATH}.tmp`;

/** @type {Record<string, string> | null} */
let idMap = null;
let dirty = false;
let saveScheduled = false;

function ensureLoaded() {
  if (idMap !== null) return;
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(MAP_PATH)) {
    try {
      idMap = JSON.parse(readFileSync(MAP_PATH, "utf8"));
    } catch {
      console.warn(`[id-map] failed to parse ${MAP_PATH}, starting fresh`);
      idMap = {};
    }
  } else {
    idMap = {};
  }
}

/**
 * Return the UUID for the given entity + SQL primary key.
 * Creates and persists a new UUID on first request; subsequent calls
 * with the same arguments return the same UUID across process restarts.
 *
 * @param {string} entity   e.g. "club", "pilot", "round"
 * @param {number|string} sqlId  The SQL table primary key value
 * @returns {string} UUID v4
 */
export function getOrCreateUuid(entity, sqlId) {
  ensureLoaded();
  const key = `${entity}:${sqlId}`;
  if (!idMap[key]) {
    idMap[key] = randomUUID();
    dirty = true;
    if (!saveScheduled) {
      saveScheduled = true;
      setImmediate(() => {
        saveScheduled = false;
        saveIdMap();
      });
    }
  }
  return idMap[key];
}

/**
 * Flush the in-memory map to disk atomically.
 * Safe to call multiple times; no-op when map is clean.
 */
export function saveIdMap() {
  if (!dirty || idMap === null) return;
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const json = JSON.stringify(idMap, null, 2);
  writeFileSync(TMP_PATH, json, "utf8");
  renameSync(TMP_PATH, MAP_PATH);
  dirty = false;
}
