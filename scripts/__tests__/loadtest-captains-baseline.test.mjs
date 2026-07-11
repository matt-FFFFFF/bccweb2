// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { LOADTEST_PHASES } from "../lib/loadTestOrchestration.mjs";

const preparePath = resolve("scripts/prepare-loadtest.mjs");
const transitionPath = resolve("scripts/transition-loadtest.mjs");
const registerK6Path = resolve("tests/load/sign-to-fly.js");
const signK6Path = resolve("tests/load/sign-phase.js");
const makefilePath = resolve("Makefile");

test("prepare persists pilot identity and provisional place while round remains Confirmed", async () => {
  // Given
  const source = await readFile(preparePath, "utf8");

  // When
  const preparedWrite = source.slice(source.indexOf("await writeJsonAtomically"));

  // Then
  assert.match(source, /place: pilot\.teamLocalRank \+ 1/);
  assert.match(source, /pilotId: pilot\.id/);
  assert.match(source, /confirmed\?\.status !== "Confirmed"/);
  assert.match(preparedWrite, /teams: slots/);
});

test("transition consumes the prepared round id and advances it to BriefComplete", async () => {
  // Given
  const source = await readFile(transitionPath, "utf8");

  // When / Then
  assert.match(source, /const roundId = prepared\.roundId/);
  assert.match(source, /rounds\/\$\{roundId\}\/brief-complete/);
});

test("k6 registration and signing address slots by prepared team and place", async () => {
  // Given
  const [registerSource, signSource] = await Promise.all([
    readFile(registerK6Path, "utf8"),
    readFile(signK6Path, "utf8"),
  ]);

  // When / Then
  assert.match(registerSource, /JSON\.stringify\(\{ teamId: slot\.teamId \}\)/);
  assert.match(signSource, /teams\/\$\{target\.teamId\}\/pilots\/\$\{target\.place\}\/sign/);
});

test("orchestrator runs captain reconciliation between registration and transition", async () => {
  // Given
  const source = await readFile(makefilePath, "utf8");

  // When / Then
  assert.match(source, /^loadtest-captains:.*\n\tnode scripts\/set-captains-loadtest\.mjs$/m);
  assert.ok(LOADTEST_PHASES.indexOf("register") < LOADTEST_PHASES.indexOf("captains"));
  assert.ok(LOADTEST_PHASES.indexOf("captains") < LOADTEST_PHASES.indexOf("transition"));
});
