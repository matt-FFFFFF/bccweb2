// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

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
  assert.match(registerSource, /teamId: slot\.teamId, preferredPlace: slot\.place/);
  assert.match(signSource, /teams\/\$\{target\.teamId\}\/pilots\/\$\{target\.place\}\/sign/);
});

test("Make runs captain reconciliation between registration and transition", async () => {
  // Given
  const source = await readFile(makefilePath, "utf8");

  // When
  const pipeline = source.match(/^loadtest: (.+)$/m)?.[1];

  // Then
  assert.ok(pipeline);
  assert.match(source, /^loadtest-captains:.*\n\tnode scripts\/set-captains-loadtest\.mjs$/m);
  assert.ok(pipeline.indexOf("loadtest-register") < pipeline.indexOf("loadtest-captains"));
  assert.ok(pipeline.indexOf("loadtest-captains") < pipeline.indexOf("loadtest-transition"));
});
