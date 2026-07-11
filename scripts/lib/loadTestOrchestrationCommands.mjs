// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { join } from "node:path";

const MINUTE = 60_000;

export function createLoadTestCommands(options) {
  const { root, eventsPath, summaryPath, artifactStdio = [] } = options;
  const loadDirectory = join(root, "tests", "load");
  const node = process.execPath;
  return {
    prepare: {
      command: node, args: [join(root, "scripts", "prepare-loadtest.mjs")],
      cwd: root, env: {}, timeoutMs: 20 * MINUTE,
    },
    register: {
      command: "k6", args: ["run", "--env", "PHASE=register", "sign-to-fly.js"],
      cwd: loadDirectory, env: {}, timeoutMs: 20 * MINUTE,
    },
    captains: {
      command: node, args: [join(root, "scripts", "set-captains-loadtest.mjs")],
      cwd: root, env: {}, timeoutMs: 15 * MINUTE,
    },
    transition: {
      command: node, args: [join(root, "scripts", "transition-loadtest.mjs")],
      cwd: root, env: {}, timeoutMs: 10 * MINUTE,
    },
    sign: {
      command: "k6",
      args: [
        "run",
        "--env", `SIGN_EVENTS_PATH=${eventsPath}`,
        "--env", `SIGN_SUMMARY_PATH=${summaryPath}`,
        "--out", `json=${eventsPath}`,
        "--summary-trend-stats=p(95),p(99)",
        "sign-phase.js",
      ],
      cwd: loadDirectory,
      env: { SIGN_EVENTS_PATH: eventsPath, SIGN_SUMMARY_PATH: summaryPath },
      timeoutMs: 10 * MINUTE,
      extraStdio: artifactStdio,
    },
    artifact: {
      command: node,
      args: [join(root, "scripts", "verify-loadtest-sign-artifacts.mjs"), eventsPath, summaryPath],
      cwd: root, env: {}, timeoutMs: MINUTE, extraStdio: artifactStdio,
    },
    verify: {
      command: node,
      args: [join(root, "scripts", "verify-loadtest-signtofly.mjs"), eventsPath, summaryPath],
      cwd: root, env: {}, timeoutMs: 10 * MINUTE, extraStdio: artifactStdio,
    },
    cleanup: {
      command: node, args: [join(root, "scripts", "cleanup-loadtest.mjs")],
      cwd: root, env: {}, timeoutMs: 10 * MINUTE,
    },
  };
}
