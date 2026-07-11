#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from "node:fs";
import { verifySignArtifacts } from "./lib/loadTestSignArtifacts.mjs";

const [eventsPath, summaryPath] = process.argv.slice(2);
if (!eventsPath || !summaryPath) {
  throw new Error("usage: verify-loadtest-sign-artifacts.mjs <events.json> <summary.json>");
}

const report = verifySignArtifacts(
  readFileSync(eventsPath, "utf8"),
  JSON.parse(readFileSync(summaryPath, "utf8")),
);
process.stdout.write(`${JSON.stringify(report)}\n`);
