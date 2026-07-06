#!/usr/bin/env node
/**
 * seed-rounds.mjs
 *
 * Pure-HTTP dev seed: drives 4 rounds through the production API lifecycle to
 * reach the four headline statuses (Proposed, Confirmed, BriefComplete, Locked)
 * so the rounds list page has something meaningful to render without manual
 * setup. Uses fixture pilots/clubs/sites/season from `.fixture-manifest.json`
 * (T8). Pure HTTP — never imports the Azure Blob SDK; the API owns the full
 * lifecycle including auto-creation of `round-briefs/{id}.json` on
 * `confirmRound` (apps/api/src/functions/roundsMutate.ts:397-407).
 *
 * Sibling of `scripts/transition-loadtest.mjs` — same env-aware, pure-HTTP
 * shape (admin login, JWT, manifest IO).
 */

import {
  BCC_API_BASE_URL,
  IS_AZURE_TARGET,
  ADMIN_EMAIL,
  ADMIN_PASSWORD_OVERRIDE,
  DEV_CREDENTIALS_PATH,
  FIXTURE_MANIFEST_PATH,
} from "./lib/loadTestConsts.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ─── Configuration ───────────────────────────────────────────────────────────

const TARGET_STATUSES = ["Proposed", "Confirmed", "BriefComplete", "Locked"];
const STATUS_RANK = { Proposed: 0, Confirmed: 1, BriefComplete: 2, Locked: 3 };
const DATE_OFFSETS_DAYS = [7, 14, 21, 28]; // one per status, visual differentiation
const TEAMS_PER_ROUND = 4;
const PILOTS_PER_TEAM = 3;

// ─── Preconditions ───────────────────────────────────────────────────────────

if (!existsSync(FIXTURE_MANIFEST_PATH)) {
  process.stderr.write(
    `[seed-rounds] Run 'make seed' first (target: ${BCC_API_BASE_URL})\n`
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST_PATH, "utf8"));
const { siteIds, clubIds, pilotIds, seasonYear } = manifest;
if (
  !Array.isArray(siteIds) ||
  siteIds.length < 1 ||
  !Array.isArray(clubIds) ||
  clubIds.length < TEAMS_PER_ROUND ||
  !Array.isArray(pilotIds) ||
  pilotIds.length < TARGET_STATUSES.length * TEAMS_PER_ROUND * PILOTS_PER_TEAM ||
  !seasonYear
) {
  process.stderr.write(
    `[seed-rounds] manifest at ${FIXTURE_MANIFEST_PATH} is missing required fixture data (siteIds/clubIds/pilotIds/seasonYear). Re-run 'make seed'.\n`
  );
  process.exit(1);
}

function resolveAdminPassword() {
  if (ADMIN_PASSWORD_OVERRIDE) return ADMIN_PASSWORD_OVERRIDE;

  if (existsSync(DEV_CREDENTIALS_PATH)) {
    const contents = readFileSync(DEV_CREDENTIALS_PATH, "utf8");
    const match = contents.match(/^ADMIN_PASSWORD=(.+)$/m);
    if (match?.[1]) return match[1].trim();
    process.stderr.write(
      `[seed-rounds] ${DEV_CREDENTIALS_PATH} exists but does not contain ADMIN_PASSWORD=...\n`
    );
    process.exit(1);
  }

  process.stderr.write(
    `[seed-rounds] missing admin password. Set ADMIN_PASSWORD${IS_AZURE_TARGET ? "" : ""} or create ${DEV_CREDENTIALS_PATH}.\n`
  );
  process.exit(1);
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function apiFetch(method, path, { token, body } = {}) {
  const url = `${BCC_API_BASE_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`HTTP ${res.status} on ${method} ${url}: ${errBody}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function isoDate(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function seedOneRound(token, statusIdx) {
  const targetStatus = TARGET_STATUSES[statusIdx];
  const date = isoDate(DATE_OFFSETS_DAYS[statusIdx]);

  // 1. Create round (Proposed)
  const createdRound = await apiFetch("POST", "/api/rounds", {
    token,
    body: { date, siteId: siteIds[0], seasonYear },
  });
  const roundId = createdRound.id;

  // 2. Add 4 teams, each with 3 pilots
  for (let clubIdx = 0; clubIdx < TEAMS_PER_ROUND; clubIdx += 1) {
    const team = await apiFetch("POST", `/api/rounds/${roundId}/teams`, {
      token,
      body: {
        clubId: clubIds[clubIdx],
        teamName: `Dev Team ${clubIdx + 1}`,
      },
    }).then((r) =>
      // addTeam returns the updated Round; find the team we just appended.
      r.teams[r.teams.length - 1]
    );
    const teamId = team.id;

    for (let place = 1; place <= PILOTS_PER_TEAM; place += 1) {
      // Deterministic, stable index across reruns + statuses; well within
      // the 500-pilot fixture pool: 4 statuses * 4 teams * 3 pilots = 48.
      const pilotIdx =
        statusIdx * TEAMS_PER_ROUND * PILOTS_PER_TEAM +
        clubIdx * PILOTS_PER_TEAM +
        (place - 1);
      // Slot eligibility is derived server-side and positionally at slot
      // creation (teams.ts addPilot: isScoring = place <=
      // config.maxScoringPilotsInTeam, =6). The addPilot handler IGNORES any
      // request-body `isScoring`, so we omit it and let the API be the single
      // source of truth — replacing the old, now-dead `isScoring: place === 1`.
      // With 3 pilots per team every slot lands in a scoring place (1..3 <= 6).
      await apiFetch(
        "POST",
        `/api/rounds/${roundId}/teams/${teamId}/pilots`,
        {
          token,
          body: { pilotId: pilotIds[pilotIdx] },
        }
      );
    }
  }

  // 3. Drive to target status via lifecycle transitions
  const rank = STATUS_RANK[targetStatus];
  if (rank >= STATUS_RANK.Confirmed) {
    // confirmRound auto-creates round-briefs/{id}.json
    // (apps/api/src/functions/roundsMutate.ts:397-407).
    await apiFetch("POST", `/api/rounds/${roundId}/confirm`, { token, body: {} });
  }
  if (rank >= STATUS_RANK.BriefComplete) {
    await apiFetch("POST", `/api/rounds/${roundId}/brief-complete`, {
      token,
      body: {},
    });
  }
  if (rank >= STATUS_RANK.Locked) {
    // lockRound catches its own PDF-generation failures internally
    // (roundsMutate.ts:724-733), so the HTTP call succeeds even if chromium
    // is missing. No script-level try/catch.
    await apiFetch("POST", `/api/rounds/${roundId}/lock`, { token, body: {} });
  }

  return roundId;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const password = resolveAdminPassword();

  const loginJson = await apiFetch("POST", "/api/auth/login", {
    body: { email: ADMIN_EMAIL, password },
  });
  const token = loginJson?.accessToken;
  if (!token) {
    throw new Error(
      `login response missing accessToken: ${JSON.stringify(loginJson)}`
    );
  }

  const roundIds = [];
  for (let i = 0; i < TARGET_STATUSES.length; i += 1) {
    const id = await seedOneRound(token, i);
    roundIds.push(id);
  }

  manifest.roundIds = roundIds;
  writeFileSync(FIXTURE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  process.stderr.write(
    `[seed-rounds] OK: target=${BCC_API_BASE_URL} 4 rounds (${TARGET_STATUSES.join("/")})\n`
  );
}

main().catch((err) => {
  process.stderr.write(
    `[seed-rounds] ${err?.stack ?? err?.message ?? String(err)}\n`
  );
  process.exit(1);
});
