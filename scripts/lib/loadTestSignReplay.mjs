// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

export async function replayPersistedSignature(options) {
  const { parsed, signatures, prepared, login, post } = options;
  const signatureByKey = new Map(signatures.map((signature) => [
    `${signature.teamId}:${signature.place}`, signature,
  ]));
  const errored = parsed.targets.find((target) => (
    (target.event.status !== 201 || target.event.outcome !== "created") &&
    signatureByKey.has(target.slotKey)
  ));
  const target = errored ?? parsed.targets.find((candidate) => (
    candidate.event.status === 201 && candidate.event.outcome === "created" &&
    signatureByKey.has(candidate.slotKey)
  ));
  if (!target) throw new Error("[verify-loadtest-signtofly] no persisted target is available for replay");
  const preparedSlot = prepared.teams[target.preparedIndex];
  const token = await login(preparedSlot.pilotEmail, preparedSlot.pilotPassword);
  const response = await post(target, token);
  const expectedId = signatureByKey.get(target.slotKey).id;
  if (response.status !== 200) {
    throw new Error(`[verify-loadtest-signtofly] replay ${target.slotKey} expected HTTP 200, got ${response.status}`);
  }
  if (response.id !== expectedId) {
    throw new Error(`[verify-loadtest-signtofly] replay ${target.slotKey} returned ID ${response.id ?? "missing"}, expected ${expectedId}`);
  }
  return { label: errored ? "recovery" : "fallback", slotKey: target.slotKey, signatureId: expectedId };
}
