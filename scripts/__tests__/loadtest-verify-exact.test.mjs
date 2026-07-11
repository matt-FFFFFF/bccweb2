// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseVerificationArtifacts,
} from "../lib/loadTestSignVerificationArtifacts.mjs";
import {
  inspectExactLedger,
  inspectRoundFlags,
  pollExactFlags,
} from "../lib/loadTestSignStateVerify.mjs";
import { replayPersistedSignature } from "../lib/loadTestSignReplay.mjs";
import { waitForReflectQueues } from "../lib/loadTestReflectQueues.mjs";
import { artifactFixture, preparedFixture, roundFixture, signaturesFixture } from "./helpers/signVerifyFixtures.mjs";

test("artifact parser projects exactly 185 prepared targets and final100", () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);

  // When
  const parsed = parseVerificationArtifacts(prepared, artifact.events, artifact.summary);

  // Then
  assert.equal(parsed.targets.length, 185);
  assert.equal(parsed.final100.length, 100);
  assert.deepEqual(parsed.cohortCounts, { 10: 10, 25: 25, 50: 50, 100: 100 });
});

for (const roundId of [undefined, null, "", "   "]) {
  test(`artifact parser rejects invalid roundId ${JSON.stringify(roundId)} before state access`, () => {
    // Given
    const prepared = { ...preparedFixture(), roundId };
    const artifact = artifactFixture(prepared);

    // When / Then
    assert.throws(
      () => parseVerificationArtifacts(prepared, artifact.events, artifact.summary),
      /PREPARED_ROUND_ID_INVALID: prepared artifact roundId must be a non-empty string/,
    );
  });
}

for (const mutation of ["duplicate", "missing", "extra", "wrong-cohort", "wrong-final100"]) {
  test(`artifact parser rejects ${mutation} target evidence with its key`, () => {
    // Given
    const prepared = preparedFixture();
    const artifact = artifactFixture(prepared, mutation);

    // When / Then
    assert.throws(
      () => parseVerificationArtifacts(prepared, artifact.events, artifact.summary),
      /team-0:1|team-18:5|team-extra:1|final100|cohort/,
    );
  });
}

test("ledger requires one exact record per target and matching event IDs", () => {
  // Given
  const prepared = preparedFixture();
  const parsed = parseVerificationArtifacts(prepared, ...Object.values(artifactFixture(prepared)));

  // When
  const ledger = inspectExactLedger(signaturesFixture(parsed), parsed);

  // Then
  assert.equal(ledger.signatures, 185);
  assert.equal(ledger.uniqueSignatureKeys, 185);
  assert.equal(ledger.finalBurst, 100);
});

for (const mutation of ["duplicate", "missing", "extra", "wrong-id", "wrong-final100-id", "duplicate-id"]) {
  test(`ledger rejects ${mutation} record with its key`, () => {
    // Given
    const prepared = preparedFixture();
    const artifact = artifactFixture(prepared);
    const parsed = parseVerificationArtifacts(prepared, artifact.events, artifact.summary);

    // When / Then
    assert.throws(
      () => inspectExactLedger(signaturesFixture(parsed, mutation), parsed),
      /team-0:1|team-18:5|team-extra:1|duplicate signature key|duplicate signature ID|signature ID|final100/,
    );
  });
}

test("ledger independently names a final100 ID mismatch", () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  const parsed = parseVerificationArtifacts(prepared, artifact.events, artifact.summary);

  // When / Then
  assert.throws(
    () => inspectExactLedger(signaturesFixture(parsed, "wrong-final100-id"), parsed),
    /final100 signature ID mismatch.*team-18:5/,
  );
});

test("ledger rejects a foreign-round record with its ID and key", () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  const parsed = parseVerificationArtifacts(prepared, artifact.events, artifact.summary);

  // When / Then
  assert.throws(
    () => inspectExactLedger(signaturesFixture(parsed, "foreign-round"), parsed),
    /LEDGER_FOREIGN_ROUND: signature signature-0 key team-0:1 belongs to round different-round; expected round-1/,
  );
});

test("ledger classifies a missing final100 record by cohort and key", () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  const parsed = parseVerificationArtifacts(prepared, artifact.events, artifact.summary);

  // When / Then
  assert.throws(
    () => inspectExactLedger(signaturesFixture(parsed, "missing"), parsed),
    /FINAL100_SIGNATURE_MISSING: final100 missing signature key team-18:5/,
  );
});

test("artifact parser rejects dishonest status outcome and signature combinations", () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  artifact.events[0] = { ...artifact.events[0], status: 200, outcome: "created" };

  // When / Then
  assert.throws(
    () => parseVerificationArtifacts(prepared, artifact.events, artifact.summary),
    /team-0:1.*invalid attempt result/,
  );
});

test("round flags require 185 targets true and 315 non-targets false", () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  const parsed = parseVerificationArtifacts(prepared, artifact.events, artifact.summary);

  // When
  const inspection = inspectRoundFlags(roundFixture(prepared, parsed), prepared, parsed.targets);

  // Then
  assert.deepEqual(inspection, { ready: true, signedFlags: 185, unsignedNonTargets: 315, problems: [] });
});

for (const mutation of ["non-target-true", "missing", "extra", "unfilled", "duplicate"]) {
  test(`round flags reject ${mutation} slot with its key`, () => {
    // Given
    const prepared = preparedFixture();
    const artifact = artifactFixture(prepared);
    const parsed = parseVerificationArtifacts(prepared, artifact.events, artifact.summary);

    // When / Then
    const action = () => inspectRoundFlags(roundFixture(prepared, parsed, mutation), prepared, parsed.targets);
    if (mutation === "non-target-true") {
      assert.equal(action().ready, false);
      assert.match(action().problems[0], /team-18:6/);
    } else {
      assert.throws(action, /team-0:1|team-extra:1|Filled|duplicate slot key/);
    }
  });
}

test("flag polling converges within an injected finite deadline", async () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  const parsed = parseVerificationArtifacts(prepared, artifact.events, artifact.summary);
  const rounds = [roundFixture(prepared, parsed, "target-false"), roundFixture(prepared, parsed)];
  let now = 0;

  // When
  const result = await pollExactFlags({
    loadRound: async () => rounds.shift(), prepared, targets: parsed.targets,
    deadlineMs: 10, intervalMs: 2, now: () => now, sleep: async (ms) => { now += ms; },
  });

  // Then
  assert.equal(result.signedFlags, 185);
});

test("replay uses an errored persisted key once and requires the same ID", async () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared, "persisted-error");
  const parsed = parseVerificationArtifacts(prepared, artifact.events, artifact.summary);
  const signatures = signaturesFixture(parsed);
  const calls = [];

  inspectExactLedger(signatures, parsed);

  // When
  const replay = await replayPersistedSignature({
    parsed, signatures, prepared,
    login: async () => "token",
    post: async (target) => { calls.push(target.slotKey); return { status: 200, id: signatures[0].id }; },
  });

  // Then
  assert.deepEqual(calls, ["team-0:1"]);
  assert.equal(replay.label, "recovery");
});

test("flag polling timeout names the target key and preserves state", async () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  const parsed = parseVerificationArtifacts(prepared, artifact.events, artifact.summary);
  let now = 0;

  // When / Then
  await assert.rejects(() => pollExactFlags({
    loadRound: async () => roundFixture(prepared, parsed, "target-false"),
    prepared, targets: parsed.targets, deadlineMs: 4, intervalMs: 2,
    now: () => now, sleep: async (ms) => { now += ms; },
  }), /team-0:1.*state preserved/);
});

test("replay labels deterministic successful-key idempotency as fallback", async () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  const parsed = parseVerificationArtifacts(prepared, artifact.events, artifact.summary);
  const signatures = signaturesFixture(parsed);

  // When
  const replay = await replayPersistedSignature({
    parsed, signatures, prepared, login: async () => "token",
    post: async () => ({ status: 200, id: signatures[0].id }),
  });

  // Then
  assert.equal(replay.label, "fallback");
  assert.equal(replay.slotKey, "team-0:1");
});

test("queue polling requires two zero observations at least two seconds apart", async () => {
  // Given
  const observations = [{ main: 1, poison: 0 }, { main: 0, poison: 0 }, { main: 0, poison: 0 }];
  let now = 0;

  // When
  const result = await waitForReflectQueues({
    readCounts: async () => observations.shift(), deadlineMs: 10_000, intervalMs: 2_000,
    now: () => now, sleep: async (ms) => { now += ms; },
  });

  // Then
  assert.deepEqual(result, { main: 0, poison: 0, stable: true });
  assert.equal(now, 4_000);
});

test("queue polling fails on poison without consuming it and times out on stale main", async () => {
  // Given
  const methods = [];
  let now = 0;

  // When / Then
  await assert.rejects(() => waitForReflectQueues({
    readCounts: async () => ({ main: 0, poison: 1 }), deadlineMs: 10_000, intervalMs: 2_000,
    now: () => now, sleep: async (ms) => { methods.push("sleep"); now += ms; },
  }), /poison.*1/);
  await assert.rejects(() => waitForReflectQueues({
    readCounts: async () => ({ main: 1, poison: 0 }), deadlineMs: 4_000, intervalMs: 2_000,
    now: () => now, sleep: async (ms) => { methods.push("sleep"); now += ms; },
  }), /timed out.*main=1.*poison=0/);
  assert.deepEqual(methods, ["sleep", "sleep"]);
});
