// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

import { replayPersistedSignature } from "./loadTestSignReplay.mjs";
import { inspectExactLedger, pollExactFlags } from "./loadTestSignStateVerify.mjs";

function fail(message) {
  throw new Error(`[verify-loadtest-signtofly] ${message}`);
}

export async function runSignVerification(options) {
  const {
    prepared, parsed, dedicatedStack, login, getSignatures,
    postReplay, loadRound, waitForQueues, flagPolling,
  } = options;
  if (dedicatedStack !== true) {
    fail("dedicated stack confirmation LOADTEST_DEDICATED_STACK=1 is required before global reflect queue counts are meaningful");
  }
  const signatures = await getSignatures(parsed.roundId);
  const ledger = inspectExactLedger(signatures, parsed);
  const flags = await pollExactFlags({
    loadRound: () => loadRound(parsed.roundId), prepared, targets: parsed.targets, ...flagPolling,
  });
  const replay = await replayPersistedSignature({
    parsed, signatures, prepared, login,
    post: (target, token) => postReplay(parsed.roundId, target, token),
  });
  const queues = await waitForQueues();
  const output = [
    `targets=${parsed.targets.length}`,
    `signatures=${ledger.signatures}`,
    `uniqueSignatureKeys=${ledger.uniqueSignatureKeys}`,
    `signedFlags=${flags.signedFlags}`,
    `finalBurst=${ledger.finalBurst}/${parsed.final100.length}`,
    `unsignedNonTargets=${flags.unsignedNonTargets}`,
    `reflectQueues=main:${queues.main},poison:${queues.poison},${queues.stable ? "stable" : "unstable"}`,
    `replay=${replay.label}`,
  ].join(" ");
  return { parsed, ledger, flags, replay, queues, output };
}
