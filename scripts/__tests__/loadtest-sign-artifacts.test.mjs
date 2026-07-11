// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { SIGN_COHORTS } from "../lib/loadTestSign.mjs";
import { verifySignArtifacts, verifySignSummary } from "../lib/loadTestSignArtifacts.mjs";

test("combined artifact verifier cross-checks setup, attempts, and summary", () => {
  // Given
  const lines = artifactLines();

  // When
  const report = verifySignArtifacts(`${lines.map(JSON.stringify).join("\n")}\n`, { metrics: summaryMetrics() });

  // Then
  assert.equal(report.setupEvents, 185);
  assert.equal(report.uniqueSignatures, 185);
  assert.deepEqual(report.attempts, { 10: 10, 25: 25, 50: 50, 100: 100 });
});

test("summary verifier rejects missing or non-finite latency values", () => {
  // Given
  const missing = summaryMetrics();
  delete missing["sign_duration{cohort:10}"].values["p(95)"];
  const nonFinite = summaryMetrics();
  nonFinite["sign_duration{cohort:25}"].values["p(99)"] = Number.NaN;

  // When / Then
  assert.throws(() => verifySignSummary({ metrics: missing }), /cohort:10.*p\(95\).*finite/);
  assert.throws(() => verifySignSummary({ metrics: nonFinite }), /cohort:25.*p\(99\).*finite/);
});

test("combined verifier rejects sign cohort that differs from setup cohort", () => {
  // Given
  const lines = artifactLines();
  const firstTen = lines.find((event) => event.metric === "sign_attempts" && event.data.tags.cohort === "10");
  const firstTwentyFive = lines.find((event) => event.metric === "sign_attempts" && event.data.tags.cohort === "25");
  firstTen.data.tags.cohort = "25";
  firstTwentyFive.data.tags.cohort = "10";

  // When / Then
  assert.throws(
    () => verifySignArtifacts(`${lines.map(JSON.stringify).join("\n")}\n`, { metrics: summaryMetrics() }),
    /setup cohort 10 but sign cohort 25/,
  );
});

test("raw event parser rejects unknown application tag by name", () => {
  // Given
  const lines = artifactLines();
  const attempt = lines.find((event) => event.metric === "sign_attempts");
  attempt.data.tags.email = "must-not-be-hidden@example.invalid";

  // When / Then
  assert.throws(
    () => verifySignArtifacts(`${lines.map(JSON.stringify).join("\n")}\n`, { metrics: summaryMetrics() }),
    /sign_attempts event has unknown tag email/,
  );
});

function artifactLines() {
  const lines = [];
  for (const { name, offset, size } of SIGN_COHORTS) {
    for (let index = 0; index < size; index += 1) {
      const slotKey = `team:${offset + index}`;
      lines.push(point("sign_setup_attempts", {
        cohort: name, group: "", slot_key: slotKey, status: "200", outcome: "authenticated",
      }));
      lines.push(point("sign_attempts", {
        cohort: name,
        group: "",
        phase: "sign",
        scenario: `sign_${name}`,
        slot_key: slotKey,
        status: "201",
        signature_id: `signature-${offset + index}`,
        outcome: "created",
      }));
    }
  }
  return lines;
}

function summaryMetrics() {
  const metrics = {};
  for (const { name, size } of SIGN_COHORTS) {
    metrics[`http_reqs{phase:sign_setup,cohort:${name}}`] = passingMetric({ count: size });
    metrics[`http_req_failed{phase:sign_setup,cohort:${name}}`] = passingMetric({ rate: 0 });
    metrics[`sign_setup_attempts{cohort:${name}}`] = passingMetric({ count: size });
    metrics[`sign_setup_errors{cohort:${name}}`] = passingMetric({ rate: 0 });
    metrics[`sign_attempts{cohort:${name}}`] = passingMetric({ count: size });
    metrics[`sign_created{cohort:${name}}`] = passingMetric({ count: size });
    metrics[`sign_errors{cohort:${name}}`] = passingMetric({ rate: 0 });
    metrics[`sign_5xx{cohort:${name}}`] = passingMetric({ rate: 0 });
    metrics[`sign_duration{cohort:${name}}`] = passingMetric({ "p(95)": 120, "p(99)": 240 });
  }
  return metrics;
}

function passingMetric(values) {
  return {
    values,
    thresholds: { gate: { ok: true }, "p(95)<2000": { ok: true }, "p(99)<5000": { ok: true } },
  };
}

function point(metric, tags) {
  return { metric, type: "Point", data: { value: 1, tags } };
}
