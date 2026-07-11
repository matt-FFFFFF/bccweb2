// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("full Make target is one sequential Node orchestrator recipe", async () => {
  // Given
  const makefile = await readFile("Makefile", "utf8");

  // When
  const definition = makefile.match(/^loadtest:([^\n]*)\n\t([^\n]+)$/mu);

  // Then
  assert.ok(definition, "loadtest target must have one recipe");
  assert.doesNotMatch(definition[1], /loadtest-(prepare|register|captains|transition|sign|verify|cleanup)/u);
  assert.equal(definition[2].trim(), "node scripts/run-loadtest.mjs");
});

test("package and CI gate the complete pure load-test contract suite", async () => {
  // Given
  const [packageText, workflow] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile(".github/workflows/ci.yml", "utf8"),
  ]);

  // When
  const scripts = JSON.parse(packageText).scripts;

  // Then
  assert.match(scripts["loadtest:test"], /scripts\/__tests__\/loadtest-\*\.test\.mjs/u);
  assert.match(scripts["loadtest:test"], /tests\/load\/\*\.test\.mjs/u);
  assert.doesNotMatch(scripts["loadtest:test"], /make loadtest|k6|azurite/iu);
  assert.match(workflow, /run: npm run loadtest:test/u);
});

test("evergreen docs state the final topology, gates, ownership, and failure policy", async () => {
  // Given
  const [agents, readme, runbook] = await Promise.all([
    readFile("AGENTS.md", "utf8"),
    readFile("tests/load/README.md", "utf8"),
    readFile("docs/runbooks/load-testing.md", "utf8"),
  ]);
  const docs = `${agents}\n${readme}\n${runbook}`;

  // When / Then
  for (const claim of [
    /500 pilots.*25 clubs.*50 (?:canonical )?teams.*10 pilots per team/isu,
    /25 coordinators.*50 captains/isu,
    /185.*315/isu,
    /10\/25\/50\/100/isu,
    /HTTP 201 only|201-only/isu,
    /p95\s*<\s*2(?:,000)?\s*(?:ms|s).*p99\s*<\s*5(?:,000)?\s*(?:ms|s)/isu,
    /withPrivateLeaseRetry/su,
    /two observations at least two seconds apart/isu,
    /10\/min.*trusted.*client-ip/isu,
    /verifier\/queue failure.*preserves\s+all\s+state\s+and\s+forbids\s+cleanup/isu,
  ]) {
    assert.match(docs, claim);
  }
});
