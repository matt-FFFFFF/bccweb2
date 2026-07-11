// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

function interruptedResult(signal) {
  return {
    exitCode: null,
    signal,
    stdout: "",
    stderr: "",
    timedOut: false,
    error: null,
    attempted: false,
  };
}

export function createInterruptionLatch() {
  let interruption = null;
  let signAttempted = false;
  let abortActive = () => undefined;
  return {
    interrupt(signal) {
      interruption ??= signal;
      abortActive();
    },
    setAbortActive(abort) {
      abortActive = abort;
    },
    markSignAttempted() {
      signAttempted = true;
    },
    beforePhase(name) {
      if (interruption === null || name === "cleanup" || signAttempted) return null;
      return interruptedResult(interruption);
    },
  };
}
