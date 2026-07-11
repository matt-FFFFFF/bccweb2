#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

import { existsSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { cleanupOwnedRoundIds } from "./lib/loadTestRoundCleanup.mjs";
import { BCC_API_BASE_URL, PREPARED_ROUND_PATH } from "./lib/loadTestConsts.mjs";
import { readLoadTestRoundState, setLoadRoundId } from "./lib/loadTestRoundState.mjs";

export async function cleanupLoadRound(options = {}) {
  const {
    cleanup = cleanupOwnedRoundIds,
    clearLoadRoundId = () => setLoadRoundId(null),
    readState = readLoadTestRoundState,
    removePrepared = () => {
      if (existsSync(PREPARED_ROUND_PATH)) unlinkSync(PREPARED_ROUND_PATH);
    },
  } = options;
  const state = await readState();
  if (state.loadRoundId === null) {
    removePrepared();
    return { roundId: null, roundCount: 0, signatureCount: 0 };
  }
  const result = await cleanup([state.loadRoundId]);
  await clearLoadRoundId();
  removePrepared();
  return { roundId: state.loadRoundId, ...result };
}

async function main() {
  const result = await cleanupLoadRound();
  if (result.roundId === null) {
    console.error("[cleanup-loadtest] no checkpointed load round; nothing to clean");
    return;
  }
  console.error(
    `[cleanup-loadtest] OK: target=${BCC_API_BASE_URL} round=${result.roundId} signatures=${result.signatureCount}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[cleanup-loadtest] fatal: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
