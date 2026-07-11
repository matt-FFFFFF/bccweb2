// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { withFixtureOperationLock } from "../../lib/fixtureOperation.mjs";

const [mode, path] = process.argv.slice(2);

function rendezvous(stage) {
  process.send?.(stage);
  return new Promise((resolve) => process.once("message", resolve));
}

const options = { path, timeoutMs: 100 };
if (mode === "reclaim") options.beforeStaleUnlink = () => rendezvous("before-stale-unlink");
if (mode === "release") options.beforeReleaseUnlink = () => rendezvous("before-release-unlink");

try {
  await withFixtureOperationLock(
    () => mode === "release" ? rendezvous("owned") : undefined,
    options,
  );
  process.send?.({ outcome: "resolved" });
} catch (error) {
  process.send?.({ outcome: "rejected", message: error instanceof Error ? error.message : String(error) });
}
