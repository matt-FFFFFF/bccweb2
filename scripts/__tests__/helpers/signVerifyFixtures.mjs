// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { SIGN_COHORTS } from "../../lib/loadTestSign.mjs";

export function preparedFixture() {
  return {
    roundId: "round-1",
    teams: Array.from({ length: 500 }, (_, index) => ({
      teamId: `team-${Math.floor(index / 10)}`,
      place: (index % 10) + 1,
      pilotEmail: `pilot-${index}@load.invalid`,
      pilotPassword: "fixture-password",
    })),
  };
}

export function artifactFixture(prepared, mutation = "valid") {
  const attempts = SIGN_COHORTS.flatMap(({ name, offset, size }) => (
    Array.from({ length: size }, (_, index) => {
      const slot = prepared.teams[offset + index];
      return { cohort: name, slotKey: `${slot.teamId}:${slot.place}`, status: 201,
        signatureId: `signature-${offset + index}`, outcome: "created" };
    })
  ));
  const targets = SIGN_COHORTS.map(({ name, offset, size, startTime }) => ({ cohort: name, offset, size, startTime }));
  if (mutation === "duplicate") attempts[1] = { ...attempts[0] };
  if (mutation === "missing") attempts.pop();
  if (mutation === "extra") attempts.push({ cohort: "100", slotKey: "team-extra:1", status: 201, signatureId: "extra", outcome: "created" });
  if (mutation === "wrong-cohort") attempts[0].cohort = "25";
  if (mutation === "wrong-final100") targets[3] = { ...targets[3], offset: 84 };
  if (mutation === "persisted-error") attempts[0] = { ...attempts[0], status: 0, signatureId: "missing", outcome: "request_error" };
  return { events: attempts, summary: { contractVersion: 1, targets } };
}

export function signaturesFixture(parsed, mutation = "valid") {
  const signatures = parsed.targets.map((target) => ({
    teamId: target.teamId,
    place: target.place,
    id: target.event.signatureId === "missing" ? `signature-${target.preparedIndex}` : target.event.signatureId,
  }));
  if (mutation === "duplicate") signatures[1] = { ...signatures[0] };
  if (mutation === "missing") signatures.pop();
  if (mutation === "extra") signatures.push({ teamId: "team-extra", place: 1, id: "extra" });
  if (mutation === "wrong-id") signatures[0].id = "wrong";
  if (mutation === "duplicate-id") signatures[1].id = signatures[0].id;
  if (mutation === "wrong-final100-id") signatures[184].id = "wrong-final100";
  return signatures;
}

export function roundFixture(_prepared, parsed, mutation = "valid") {
  const targetKeys = new Set(parsed.targets.map(({ slotKey }) => slotKey));
  const teams = Array.from({ length: 50 }, (_, teamIndex) => ({
    id: `team-${teamIndex}`,
    pilots: Array.from({ length: 10 }, (_, placeIndex) => {
      const key = `team-${teamIndex}:${placeIndex + 1}`;
      return { placeInTeam: placeIndex + 1, status: "Filled", signToFly: targetKeys.has(key) };
    }),
  }));
  if (mutation === "non-target-true") teams[18].pilots[5].signToFly = true;
  if (mutation === "target-false") teams[0].pilots[0].signToFly = false;
  if (mutation === "missing") teams[0].pilots.shift();
  if (mutation === "extra") teams.push({ id: "team-extra", pilots: [{ placeInTeam: 1, status: "Filled", signToFly: false }] });
  if (mutation === "unfilled") teams[0].pilots[0].status = "Empty";
  if (mutation === "duplicate") teams[0].pilots.push({ ...teams[0].pilots[0] });
  return { teams };
}
