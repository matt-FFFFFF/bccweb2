// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  BCC_API_BASE_URL,
  ADMIN_EMAIL,
  ADMIN_PASSWORD_OVERRIDE,
  DEV_CREDENTIALS_PATH,
  PREPARED_ROUND_PATH,
} from "./lib/loadTestConsts.mjs";
import { readFileSync, existsSync } from "node:fs";

if (!existsSync(PREPARED_ROUND_PATH)) {
  console.error(
    `[transition-loadtest] missing ${PREPARED_ROUND_PATH}. Run 'make loadtest-prepare' first (target: ${BCC_API_BASE_URL}).`
  );
  process.exit(1);
}

const prepared = JSON.parse(readFileSync(PREPARED_ROUND_PATH, "utf8"));
const roundId = prepared.roundId;

if (!roundId) {
  console.error(`[transition-loadtest] ${PREPARED_ROUND_PATH} is missing roundId`);
  process.exit(1);
}

function resolveAdminPassword() {
  if (ADMIN_PASSWORD_OVERRIDE) return ADMIN_PASSWORD_OVERRIDE;

  if (existsSync(DEV_CREDENTIALS_PATH)) {
    const contents = readFileSync(DEV_CREDENTIALS_PATH, "utf8");
    const match = contents.match(/^ADMIN_PASSWORD=(.+)$/m);
    if (match?.[1]) return match[1];
    console.error(
      `[transition-loadtest] ${DEV_CREDENTIALS_PATH} exists but does not contain ADMIN_PASSWORD=...`
    );
    process.exit(1);
  }

  console.error(
    `[transition-loadtest] missing admin password. Set ADMIN_PASSWORD_OVERRIDE or create ${DEV_CREDENTIALS_PATH}.`
  );
  process.exit(1);
}

const password = resolveAdminPassword();

const loginRes = await fetch(`${BCC_API_BASE_URL}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: ADMIN_EMAIL, password }),
});

const loginText = await loginRes.text();
if (!loginRes.ok) {
  console.error(`[transition-loadtest] login HTTP ${loginRes.status}: ${loginText}`);
  process.exit(1);
}

let loginJson;
try {
  loginJson = JSON.parse(loginText);
} catch {
  console.error(`[transition-loadtest] login returned non-JSON: ${loginText}`);
  process.exit(1);
}

const accessToken = loginJson.accessToken;
if (!accessToken) {
  console.error(`[transition-loadtest] login response missing accessToken: ${loginText}`);
  process.exit(1);
}

const transitionRes = await fetch(
  `${BCC_API_BASE_URL}/api/rounds/${roundId}/brief-complete`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  }
);

if (!transitionRes.ok) {
  const errBody = await transitionRes.text();
  console.error(`[transition-loadtest] HTTP ${transitionRes.status}: ${errBody}`);
  process.exit(1);
}

console.error(
  `[transition-loadtest] OK: target=${BCC_API_BASE_URL} round ${roundId} → BriefComplete`
);
