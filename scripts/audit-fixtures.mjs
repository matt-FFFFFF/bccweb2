#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { readFile } from "node:fs/promises";

import {
  getPrivateContainer,
  getPublicContainer,
} from "./lib/blobSeed.mjs";
import { auditFixtureStorage } from "./lib/fixtureAudit.mjs";
import { FIXTURE_MANIFEST_PATH } from "./lib/loadTestConsts.mjs";

async function main() {
  const manifest = JSON.parse(await readFile(FIXTURE_MANIFEST_PATH, "utf8"));
  const report = await auditFixtureStorage(
    getPublicContainer(),
    getPrivateContainer(),
    manifest
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[fixture-audit] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
