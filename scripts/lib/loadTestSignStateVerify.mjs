// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

const PREPARED_COUNT = 500;

function fail(message) {
  throw new Error(`[verify-loadtest-signtofly] ${message}`);
}

function keyOf(value) {
  return `${value.teamId}:${value.place ?? value.placeInTeam}`;
}

export function inspectExactLedger(signatures, parsed) {
  if (!Array.isArray(signatures)) fail("GET signatures returned non-array");
  const ledgerByKey = new Map();
  const ledgerIds = new Set();
  for (const signature of signatures) {
    if (!signature || typeof signature.roundId !== "string" ||
        typeof signature.teamId !== "string" || !Number.isInteger(signature.place) ||
        typeof signature.id !== "string" || signature.id.length === 0) {
      fail("GET signatures returned an invalid record");
    }
    const key = keyOf(signature);
    if (signature.roundId !== parsed.roundId) {
      fail(`LEDGER_FOREIGN_ROUND: signature ${signature.id} key ${key} belongs to round ${signature.roundId}; expected ${parsed.roundId}`);
    }
    if (ledgerByKey.has(key)) fail(`duplicate signature key ${key}`);
    if (ledgerIds.has(signature.id)) fail(`duplicate signature ID ${signature.id} at ${key}`);
    ledgerByKey.set(key, signature);
    ledgerIds.add(signature.id);
  }
  for (const target of parsed.final100) {
    const signature = ledgerByKey.get(target.slotKey);
    if (!signature) {
      fail(`FINAL100_SIGNATURE_MISSING: final100 missing signature key ${target.slotKey}`);
    }
    if (target.event.signatureId !== "missing" && signature?.id !== target.event.signatureId) {
      fail(`FINAL100_SIGNATURE_ID_MISMATCH: final100 signature ID mismatch for ${target.slotKey}`);
    }
  }
  for (const target of parsed.targets) {
    const signature = ledgerByKey.get(target.slotKey);
    if (!signature) fail(`missing signature key ${target.slotKey}`);
    const eventHasId = target.event.signatureId !== "missing";
    if (eventHasId && signature.id !== target.event.signatureId) {
      fail(`signature ID mismatch for ${target.slotKey}: ledger=${signature.id} event=${target.event.signatureId}`);
    }
    ledgerByKey.delete(target.slotKey);
  }
  if (ledgerByKey.size > 0) fail(`extra signature key ${ledgerByKey.keys().next().value}`);
  return { signatures: signatures.length, uniqueSignatureKeys: signatures.length, finalBurst: parsed.final100.length };
}

function roundSlots(round) {
  if (!round || typeof round !== "object" || !Array.isArray(round.teams)) {
    fail("round response must contain teams");
  }
  const slots = new Map();
  for (const team of round.teams) {
    if (!team || typeof team.id !== "string" || !Array.isArray(team.pilots)) {
      fail("round response has invalid team");
    }
    for (const slot of team.pilots) {
      const key = `${team.id}:${slot?.placeInTeam}`;
      if (slots.has(key)) fail(`duplicate slot key ${key}`);
      slots.set(key, slot);
    }
  }
  return slots;
}

export function inspectRoundFlags(round, prepared, targets) {
  const expectedKeys = new Set(prepared.teams.map(keyOf));
  if (expectedKeys.size !== PREPARED_COUNT) fail("prepared artifact contains duplicate slot keys");
  const targetKeys = new Set(targets.map(({ slotKey }) => slotKey));
  const actual = roundSlots(round);
  for (const key of expectedKeys) {
    if (!actual.has(key)) fail(`missing round slot ${key}`);
  }
  for (const key of actual.keys()) {
    if (!expectedKeys.has(key)) fail(`extra round slot ${key}`);
  }
  const problems = [];
  let signedFlags = 0;
  let unsignedNonTargets = 0;
  for (const [key, slot] of actual) {
    if (slot.status !== "Filled") fail(`round slot ${key} expected Filled, got ${slot.status ?? "missing"}`);
    if (targetKeys.has(key)) {
      if (slot.signToFly === true) signedFlags += 1;
      else problems.push(`${key}: target signToFly=${String(slot.signToFly)}`);
    } else if (slot.signToFly === false) unsignedNonTargets += 1;
    else problems.push(`${key}: non-target signToFly=${String(slot.signToFly)}`);
  }
  return { ready: problems.length === 0 && signedFlags === 185 && unsignedNonTargets === 315,
    signedFlags, unsignedNonTargets, problems };
}

export async function pollExactFlags(options) {
  const { loadRound, prepared, targets, deadlineMs, intervalMs, now, sleep } = options;
  const deadline = now() + deadlineMs;
  let last;
  while (now() <= deadline) {
    last = inspectRoundFlags(await loadRound(), prepared, targets);
    if (last.ready) return last;
    if (now() >= deadline) break;
    await sleep(Math.min(intervalMs, deadline - now()));
  }
  fail(`timed out waiting for exact sign flags: ${last?.problems.slice(0, 5).join(", ") || "no inspection"}; state preserved`);
}
