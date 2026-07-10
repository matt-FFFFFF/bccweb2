#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * prepare-loadtest.mjs — Phase 1 of load-test pipeline (T11).
 *
 * Creates a load-test round + 50 teams via the HTTP API, confirms the round
 * (which auto-creates the brief blob), and emits tests/load/.prepared-round.json
 * for k6 (T15) to consume.
 *
 * Pure HTTP: no Blob SDK. Works against local Functions host or a deployed
 * Azure target via BCC_API_BASE_URL.
 *
 * Slots are NOT pre-filled — the k6 register phase exercises register-self
 * contention against the live API.
 */

import {
  BCC_API_BASE_URL,
  IS_AZURE_TARGET,
  ADMIN_EMAIL,
  ADMIN_PASSWORD_OVERRIDE,
  DEV_CREDENTIALS_PATH,
  FIXTURE_MANIFEST_PATH,
  PREPARED_ROUND_PATH,
  FIXTURE_PILOT_PASSWORD,
  FIXTURE_PILOT_EMAIL_PATTERN,
  LOADTEST_TEAMS,
  LOADTEST_SLOTS_PER_TEAM,
} from "./lib/loadTestConsts.mjs";
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

// ─── Preconditions ───────────────────────────────────────────────────────────

if (!existsSync(FIXTURE_MANIFEST_PATH)) {
  console.error(`Run 'make seed' first (target: ${BCC_API_BASE_URL})`);
  process.exit(1);
}

function resolveAdminPassword() {
  if (ADMIN_PASSWORD_OVERRIDE) return ADMIN_PASSWORD_OVERRIDE;
  if (existsSync(DEV_CREDENTIALS_PATH)) {
    const match = readFileSync(DEV_CREDENTIALS_PATH, "utf8").match(
      /^ADMIN_PASSWORD=(.+)$/m
    );
    if (match?.[1]) return match[1];
  }
  console.error(
    "No admin credentials. Set ADMIN_PASSWORD env (Azure mode) or run 'docker compose up' first (local mode)."
  );
  process.exit(1);
}

const adminPassword = resolveAdminPassword();
const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST_PATH, "utf8"));

if (!Array.isArray(manifest.siteIds) || manifest.siteIds.length === 0) {
  console.error("[prepare-loadtest] manifest missing siteIds");
  process.exit(1);
}
if (!Array.isArray(manifest.clubIds) || manifest.clubIds.length < LOADTEST_TEAMS) {
  console.error(
    `[prepare-loadtest] manifest has ${manifest.clubIds?.length ?? 0} clubs, need >= ${LOADTEST_TEAMS}`
  );
  process.exit(1);
}
if (
  !Array.isArray(manifest.pilotIds) ||
  manifest.pilotIds.length < LOADTEST_TEAMS * LOADTEST_SLOTS_PER_TEAM
) {
  console.error(
    `[prepare-loadtest] manifest has ${manifest.pilotIds?.length ?? 0} pilots, need >= ${LOADTEST_TEAMS * LOADTEST_SLOTS_PER_TEAM}`
  );
  process.exit(1);
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

const CONCURRENCY = IS_AZURE_TARGET ? 5 : 10;

async function callApi(method, path, { token, body, retries = 0 } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let lastErr;
  // attempts = 1 + retries; retries are used for lease-conflict (HTTP 500 INTERNAL)
  // when many concurrent writes target the same round blob.
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${BCC_API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(
          `[prepare-loadtest] ${method} ${path} returned non-JSON: ${text}`
        );
      }
    }
    lastErr = new Error(
      `[prepare-loadtest] ${method} ${path} → HTTP ${res.status}: ${text}`
    );
    // Only retry on 500 (lease contention surfaces as INTERNAL) and 409 (CONFLICT).
    if (attempt < retries && (res.status === 500 || res.status === 409)) {
      const backoffMs = 50 * 2 ** attempt + Math.floor(Math.random() * 50);
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }
    throw lastErr;
  }
  throw lastErr; // unreachable
}

async function inChunks(items, size, worker) {
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    await Promise.all(slice.map(worker));
  }
}

// ─── Login ───────────────────────────────────────────────────────────────────

const login = await callApi("POST", "/api/auth/login", {
  body: { email: ADMIN_EMAIL, password: adminPassword },
});
const token = login?.accessToken;
if (!token) {
  console.error("[prepare-loadtest] login response missing accessToken");
  process.exit(1);
}

// ─── 1) Create the round (status Proposed) ───────────────────────────────────

function isoDatePlusDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10); // yyyy-MM-dd
}

const siteId = manifest.siteIds[0];
const seasonYear = manifest.seasonYear;

const createdRound = await callApi("POST", "/api/rounds", {
  token,
  body: {
    // 21 days out (not 7) so the load-test round can coexist with seed-rounds.mjs's
    // Proposed round (at +7 days) without triggering DOUBLE_BOOKING in
    // ensureNotDoubleBooked (roundRegistration.ts:286-307).
    date: isoDatePlusDays(21),
    siteId,
    seasonYear,
    maxTeams: LOADTEST_TEAMS, // default is 8 — must override to fit 50 teams
    // register-self requires round.organisingClub to be set
    // (apps/api/src/functions/roundRegistration.ts:243-244). The 500 VUs all
    // register against THIS club; autoAllocatePilotsToRoundClub (set by T8
    // seed-fixtures) lets pilots from other fixture clubs join.
    organisingClubId: manifest.clubIds[0],
  },
});
const roundId = createdRound.id;
if (!roundId) {
  console.error("[prepare-loadtest] createRound response missing id");
  process.exit(1);
}

// ─── 2) Add 50 teams ─────────────────────────────────────────────────────────

const teamSpecs = Array.from({ length: LOADTEST_TEAMS }, (_, i) => ({
  index: i, // 0..49 — preserves teamN ordering for prepared.teams build
  // All 50 teams MUST belong to the organising club so findTeamForPilotClub
  // (roundRegistration.ts:280) accepts pilot registrations regardless of
  // their seasonal club. teams.ts addTeam only enforces r.maxTeams (not
  // config.maxTeamsInClub) and de-dupes on (teamName, clubId) — unique
  // teamNames keep us safe.
  clubId: manifest.clubIds[0],
  teamName: `Loadtest Team ${String(i + 1).padStart(2, "0")}`,
}));

const teamIds = new Array(LOADTEST_TEAMS);
const teamsStart = performance.now();

await inChunks(teamSpecs, CONCURRENCY, async (spec) => {
  // Each addTeam takes a 30s lease on rounds/{id}.json; concurrent writes to
  // the same round collide. Retry with backoff so the configured chunk size
  // doesn't fail on lease contention.
  const round = await callApi("POST", `/api/rounds/${roundId}/teams`, {
    token,
    body: { clubId: spec.clubId, teamName: spec.teamName },
    retries: 8,
  });
  // addTeam returns the whole round; find the team we just added by name.
  // Names are unique because we use clubIdx+1 padded.
  const created = round.teams.find((t) => t.teamName === spec.teamName);
  if (!created) {
    throw new Error(
      `[prepare-loadtest] team "${spec.teamName}" not found in addTeam response for round ${roundId}`
    );
  }
  teamIds[spec.index] = created.id;
});

const teamsMs = Math.round(performance.now() - teamsStart);

for (let i = 0; i < LOADTEST_TEAMS; i++) {
  if (!teamIds[i]) {
    console.error(`[prepare-loadtest] missing teamId for index ${i}`);
    process.exit(1);
  }
}

// ─── 3) Confirm the round (Proposed → Confirmed; auto-creates brief blob) ───

const confirmed = await callApi("POST", `/api/rounds/${roundId}/confirm`, {
  token,
  body: {},
});
if (confirmed.status !== "Confirmed") {
  console.error(
    `[prepare-loadtest] expected Confirmed, got status=${confirmed.status}`
  );
  process.exit(1);
}

// ─── 4) Build prepared.teams (500 entries: 50 teams × 10 places) ─────────────

const slots = [];
for (let teamN = 1; teamN <= LOADTEST_TEAMS; teamN++) {
  for (let place = 1; place <= LOADTEST_SLOTS_PER_TEAM; place++) {
    const pilotIdx = (teamN - 1) * LOADTEST_SLOTS_PER_TEAM + (place - 1); // 0-based
    slots.push({
      teamId: teamIds[teamN - 1],
      place,
      pilotEmail: FIXTURE_PILOT_EMAIL_PATTERN(pilotIdx + 1),
      pilotPassword: FIXTURE_PILOT_PASSWORD,
      pilotId: manifest.pilotIds[pilotIdx],
    });
  }
}

const prepared = {
  roundId,
  seasonYear,
  siteId,
  teams: slots,
  baseUrl: BCC_API_BASE_URL,
  isAzureTarget: IS_AZURE_TARGET,
};

// ─── 5) Write tests/load/.prepared-round.json (chmod 600) ────────────────────

mkdirSync(dirname(PREPARED_ROUND_PATH), { recursive: true });
writeFileSync(PREPARED_ROUND_PATH, JSON.stringify(prepared, null, 2));
chmodSync(PREPARED_ROUND_PATH, 0o600);

console.error(
  `[prepare-loadtest] OK: target=${BCC_API_BASE_URL} round=${roundId} teams=${LOADTEST_TEAMS} slots=${slots.length} status=Confirmed (brief auto-created) teamsMs=${teamsMs}`
);
