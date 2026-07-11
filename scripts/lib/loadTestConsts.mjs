// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
export { DEV_CREDENTIALS_PATH } from "./devCredentials.mjs";
export const ADMIN_EMAIL = "admin@bcc.local";
export const FIXTURE_PILOT_PASSWORD = "loadtest-pw-bcc";

export const FIXTURE_PILOT_EMAIL_PATTERN = (n) =>
  `pilot${String(n).padStart(3, "0")}@bcc.local`;

export const FIXTURE_CLUB_NAME = (n) => `Club ${String(n).padStart(2, "0")}`;

export const FIXTURE_TEAM_NAME = (clubN, teamN) =>
  `Club ${String(clubN).padStart(2, "0")} Team ${teamN === 1 ? "A" : "B"}`;

export const PILOT_COUNT = 500;
export const CLUB_COUNT = 25;
export const TEAMS_PER_CLUB = 2;
export const LOADTEST_TEAMS = 50;
export const LOADTEST_SLOTS_PER_TEAM = 10;

export const FIXTURE_MANIFEST_PATH = ".fixture-manifest.json";
export const PREPARED_ROUND_PATH = "tests/load/.prepared-round.json";
export const SEASON_YEAR = new Date().getFullYear();

export const TS_CS_VERSION = 1; // MIRROR: apps/api/src/lib/termsConstants.ts — keep in lockstep

export const BCC_API_BASE_URL =
  process.env.BCC_API_BASE_URL ?? "http://localhost:7071";

export const IS_AZURE_TARGET =
  !BCC_API_BASE_URL.startsWith("http://localhost") &&
  !BCC_API_BASE_URL.startsWith("http://127.");

export const ADMIN_PASSWORD_OVERRIDE = process.env.ADMIN_PASSWORD ?? null;
