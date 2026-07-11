// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createInterruptionLatch } from "../lib/loadTestInterruption.mjs";

test("interruption between pre-sign phases is latched for the next phase", () => {
  // Given
  const latch = createInterruptionLatch();

  // When
  latch.interrupt("SIGINT");

  // Then
  assert.deepEqual(latch.beforePhase("register"), {
    exitCode: null,
    signal: "SIGINT",
    stdout: "",
    stderr: "",
    timedOut: false,
    error: null,
    attempted: false,
  });
  assert.equal(latch.beforePhase("cleanup"), null);
});

test("interruption after sign starts cannot suppress artifact or exact verification", () => {
  // Given
  const latch = createInterruptionLatch();
  latch.markSignAttempted();

  // When
  latch.interrupt("SIGTERM");

  // Then
  assert.equal(latch.beforePhase("artifact"), null);
  assert.equal(latch.beforePhase("verify"), null);
  assert.equal(latch.beforePhase("cleanup"), null);
});
