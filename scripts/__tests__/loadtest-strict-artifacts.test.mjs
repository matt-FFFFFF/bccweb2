// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  LOADTEST_PHASES,
  parseOrchestrationReport,
} from "../lib/loadTestOrchestration.mjs";
import { parseVerificationArtifacts } from "../lib/loadTestSignVerificationArtifacts.mjs";
import { artifactFixture, preparedFixture } from "./helpers/signVerifyFixtures.mjs";

function orchestrationReport() {
  return {
    version: 1,
    status: "passed",
    exitCode: 0,
    startedAtMs: 1,
    finishedAtMs: 2,
    phases: LOADTEST_PHASES.map((name) => ({ name, status: "passed" })),
    notes: [],
  };
}

test("status parser rejects report and phase credential extras before projection", () => {
  // Given
  const report = orchestrationReport();
  const reportWithToken = { ...report, token: "must-not-survive" };
  const phasesWithAuthorization = report.phases.map((phase, index) => (
    index === 0 ? { ...phase, Authorization: "Bearer must-not-survive" } : phase
  ));

  // When / Then
  assert.throws(
    () => parseOrchestrationReport(reportWithToken),
    /orchestration report has unknown key token/,
  );
  assert.throws(
    () => parseOrchestrationReport({ ...report, phases: phasesWithAuthorization }),
    /orchestration phase prepare has unknown key Authorization/,
  );
});

test("status parser requires all eight phases in exact order", () => {
  // Given
  const report = orchestrationReport();
  const incomplete = { ...report, phases: report.phases.slice(0, -1) };
  const reordered = {
    ...report,
    phases: [report.phases[1], report.phases[0], ...report.phases.slice(2)],
  };

  // When / Then
  assert.throws(
    () => parseOrchestrationReport(incomplete),
    /exactly equal prepare\/register\/captains\/transition\/sign\/artifact\/verify\/cleanup; got prepare\/register\/captains\/transition\/sign\/artifact\/verify/,
  );
  assert.throws(
    () => parseOrchestrationReport(reordered),
    /exactly equal prepare\/register\/captains\/transition\/sign\/artifact\/verify\/cleanup; got register\/prepare\/captains\/transition\/sign\/artifact\/verify\/cleanup/,
  );
});

test("artifact parser rejects credential extras at fixed summary boundaries", () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  const cases = [
    [{ ...artifact.summary, token: "must-not-survive" }, /sign summary has unknown key token/],
    [{ ...artifact.summary, targets: artifact.summary.targets.map((target, index) => (
      index === 0 ? { ...target, Authorization: "Bearer must-not-survive" } : target
    )) }, /sign summary target 10 has unknown key Authorization/],
    [{ ...artifact.summary, thresholds: {
      ...artifact.summary.thresholds,
      connectionString: "must-not-survive",
    } }, /sign summary thresholds has unknown key connectionString/],
    [{ ...artifact.summary, thresholds: {
      ...artifact.summary.thresholds,
      latencyMs: { ...artifact.summary.thresholds.latencyMs, token: "must-not-survive" },
    } }, /sign summary thresholds latencyMs has unknown key token/],
  ];

  // When / Then
  for (const [summary, expected] of cases) {
    assert.throws(() => parseVerificationArtifacts(prepared, artifact.events, summary), expected);
  }
});
