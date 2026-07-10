#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD_OVERRIDE,
  BCC_API_BASE_URL,
  DEV_CREDENTIALS_PATH,
  FIXTURE_PILOT_EMAIL_PATTERN,
  FIXTURE_PILOT_PASSWORD,
  IS_AZURE_TARGET,
  PREPARED_ROUND_PATH,
} from "./lib/loadTestConsts.mjs";
import { existsSync, readFileSync } from "node:fs";

const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_500;

function fail(message) {
  throw new Error(`[verify-loadtest-signtofly] ${message}`);
}

function resolveAdminPassword() {
  if (ADMIN_PASSWORD_OVERRIDE) return ADMIN_PASSWORD_OVERRIDE;

  if (existsSync(DEV_CREDENTIALS_PATH)) {
    const contents = readFileSync(DEV_CREDENTIALS_PATH, "utf8");
    const match = contents.match(/^ADMIN_PASSWORD=(.+)$/m);
    if (match?.[1]) return match[1];
    fail(`${DEV_CREDENTIALS_PATH} exists but does not contain ADMIN_PASSWORD=...`);
  }

  fail(
    `missing admin password. Set ADMIN_PASSWORD or create ${DEV_CREDENTIALS_PATH}.`,
  );
}

function assertNonProductionTarget() {
  const host = new URL(BCC_API_BASE_URL).hostname.toLowerCase();
  if (/(^|[.-])prod([.-]|$)/u.test(host) || host.includes("production")) {
    fail(`refusing to run against production-looking target: ${BCC_API_BASE_URL}`);
  }
}

async function callApi(method, path, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BCC_API_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      fail(`${method} ${path} returned non-JSON: ${text}`);
    }
  }

  if (!res.ok) {
    fail(`${method} ${path} → HTTP ${res.status}: ${text}`);
  }

  return { status: res.status, json };
}

async function login(email, password) {
  const { json } = await callApi("POST", "/api/auth/login", {
    body: { email, password },
  });
  const accessToken = json?.accessToken;
  if (!accessToken) {
    fail(`login response missing accessToken for ${email}: ${JSON.stringify(json)}`);
  }
  return accessToken;
}

function readPreparedRound() {
  if (!existsSync(PREPARED_ROUND_PATH)) {
    fail(
      `missing ${PREPARED_ROUND_PATH}. Run 'make loadtest-prepare' and the register/sign phases first (target: ${BCC_API_BASE_URL}).`,
    );
  }

  const prepared = JSON.parse(readFileSync(PREPARED_ROUND_PATH, "utf8"));
  if (!prepared?.roundId) fail(`${PREPARED_ROUND_PATH} is missing roundId`);
  if (!Array.isArray(prepared.teams) || prepared.teams.length === 0) {
    fail(`${PREPARED_ROUND_PATH} is missing signed slot metadata`);
  }

  return prepared;
}

function slotKey(teamId, place) {
  return `${teamId}:${place}`;
}

function findRoundSlot(round, teamId, place) {
  const team = round.teams?.find((candidate) => candidate.id === teamId);
  const slot = team?.pilots?.find((candidate) => candidate.placeInTeam === place);
  return { team, slot };
}

function inspectSignToFly(round, expectedSlots) {
  const expectedProblems = [];
  const expectedKeys = new Set();

  for (const expected of expectedSlots) {
    expectedKeys.add(slotKey(expected.teamId, expected.place));
    const { team, slot } = findRoundSlot(round, expected.teamId, expected.place);
    if (!team || !slot) {
      expectedProblems.push(`${expected.teamId}/${expected.place}: missing slot`);
      continue;
    }
    if (slot.status !== "Filled") {
      expectedProblems.push(
        `${expected.teamId}/${expected.place}: status=${slot.status ?? "missing"}`,
      );
      continue;
    }
    if (slot.signToFly !== true) {
      expectedProblems.push(`${expected.teamId}/${expected.place}: signToFly=false`);
    }
  }

  const filledUnsigned = [];
  let filledCount = 0;
  for (const team of round.teams ?? []) {
    for (const slot of team.pilots ?? []) {
      if (slot.status !== "Filled") continue;
      filledCount += 1;
      if (slot.signToFly !== true) {
        filledUnsigned.push(`${team.id}/${slot.placeInTeam}`);
      }
    }
  }

  return {
    filledCount,
    ready: expectedProblems.length === 0 && filledUnsigned.length === 0,
    expectedProblems,
    filledUnsigned,
    expectedKeys,
  };
}

async function waitForSignToFly(roundId, expectedSlots, token) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastInspection = null;

  while (Date.now() <= deadline) {
    const { json: round } = await callApi("GET", `/api/rounds/${roundId}`, { token });
    lastInspection = inspectSignToFly(round, expectedSlots);
    if (lastInspection.ready) return lastInspection;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const expectedSample = lastInspection?.expectedProblems.slice(0, 5).join(", ");
  const filledSample = lastInspection?.filledUnsigned.slice(0, 5).join(", ");
  fail(
    `timed out after ${POLL_TIMEOUT_MS}ms waiting for signToFly reflection; filled=${lastInspection?.filledCount ?? 0}; expected slot problems=${expectedSample || "none"}; filled unsigned=${filledSample || "none"}`,
  );
}

function findIdempotencySlot(signatures, preparedSlots) {
  for (const slot of preparedSlots) {
    const signature = signatures.find(
      (candidate) => candidate.teamId === slot.teamId && candidate.place === slot.place,
    );
    if (signature?.id) return { slot, signature };
  }
  fail("could not find a signed prepared slot for idempotency check");
}

async function assertIdempotentResign(roundId, signatures, preparedSlots) {
  const { slot, signature } = findIdempotencySlot(signatures, preparedSlots);
  const pilotIndex = preparedSlots.indexOf(slot);
  const email = slot.pilotEmail ?? FIXTURE_PILOT_EMAIL_PATTERN(pilotIndex + 1);
  const password = slot.pilotPassword ?? FIXTURE_PILOT_PASSWORD;
  const token = await login(email, password);
  const { status, json } = await callApi(
    "POST",
    `/api/rounds/${roundId}/teams/${slot.teamId}/pilots/${slot.place}/sign`,
    { token },
  );

  if (status !== 200) {
    fail(`idempotent re-sign expected HTTP 200, got HTTP ${status}`);
  }
  if (json?.id !== signature.id) {
    fail(
      `idempotent re-sign returned signature id ${json?.id ?? "missing"}; expected existing id ${signature.id}`,
    );
  }
}

async function main() {
  assertNonProductionTarget();
  const prepared = readPreparedRound();
  const roundId = prepared.roundId;
  const expectedSlots = prepared.teams;
  const expectedCount = expectedSlots.length;

  const adminToken = await login(ADMIN_EMAIL, resolveAdminPassword());
  const { json: signatures } = await callApi(
    "GET",
    `/api/rounds/${roundId}/signatures`,
    { token: adminToken },
  );
  if (!Array.isArray(signatures)) {
    fail(`GET signatures returned non-array: ${JSON.stringify(signatures)}`);
  }
  if (signatures.length !== expectedCount) {
    fail(`expected ${expectedCount} signatures, found ${signatures.length}`);
  }

  const inspection = await waitForSignToFly(roundId, expectedSlots, adminToken);
  await assertIdempotentResign(roundId, signatures, expectedSlots);

  console.error(
    `[verify-loadtest-signtofly] OK: target=${BCC_API_BASE_URL} azure=${IS_AZURE_TARGET} round=${roundId} signatures=${signatures.length} filled=${inspection.filledCount} signToFly=true idempotentReSign=ok`,
  );
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? String(err));
  process.exit(1);
});
