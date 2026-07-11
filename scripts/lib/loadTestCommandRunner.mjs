// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { spawn } from "node:child_process";

const FORCE_KILL_DELAY_MS = 1_000;

function errorText(error) {
  if (!(error instanceof Error)) return "unknown spawn error";
  const code = typeof error.code === "string" ? `${error.code}: ` : "";
  return `${code}${error.message}`;
}

export function runCommand(specification) {
  const {
    command,
    args,
    cwd,
    env,
    timeoutMs,
    signal,
  } = specification;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    let timedOut = false;
    let forceKillTimer = null;

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { spawnError = errorText(error); });

    const terminate = (timeout) => {
      timedOut ||= timeout;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    };
    const timeoutTimer = setTimeout(() => terminate(true), timeoutMs);
    timeoutTimer.unref();
    const abort = () => terminate(false);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    child.on("close", (exitCode, childSignal) => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== null) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      resolve({
        exitCode: spawnError === null ? exitCode : null,
        signal: spawnError === null ? childSignal : null,
        stdout,
        stderr,
        timedOut,
        error: spawnError,
      });
    });
  });
}
