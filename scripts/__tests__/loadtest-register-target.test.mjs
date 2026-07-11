// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(".");
const DEFAULT_LOG_DIRECTORY = resolve("logs/load-test");

for (const expectedK6Exit of [0, 107]) {
  test(`loadtest-register captures output and exposes k6 exit ${expectedK6Exit}`, async () => {
    // Given a deterministic fake k6 process and private log path
    const directory = await mkdtemp(join(tmpdir(), "bcc-register-target-"));
    const logPath = join(directory, "register.log");
    const marker = `register-target-${expectedK6Exit}-${process.pid}`;
    await writeFile(
      join(directory, "k6"),
      `#!/bin/sh\nprintf '%s\\n' "$TASK8_MARKER"\nprintf 'stderr-%s\\n' "$TASK8_MARKER" >&2\nexit "$TASK8_K6_EXIT"\n`,
      { mode: 0o755 },
    );

    try {
      // When the real Make target captures the fake process output
      const result = await runMake(directory, logPath, marker, expectedK6Exit);
      // Then output is retained and failure cannot be masked by capture
      assert.equal(result.code === 0, expectedK6Exit === 0, result.output);
      assert.match(result.output, new RegExp(marker));
      assert.match(await readFile(logPath, "utf8"), new RegExp(`stderr-${marker}`));
      if (expectedK6Exit !== 0) assert.match(result.output, /Error 107/);
    } finally {
      await removeMarkerLogs(marker);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

function runMake(directory, logPath, marker, expectedK6Exit) {
  return new Promise((resolveResult, reject) => {
    const child = spawn("make", ["loadtest-register"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        REGISTER_LOG_PATH: logPath,
        TASK8_K6_EXIT: String(expectedK6Exit),
        TASK8_MARKER: marker,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, output }));
  });
}

async function removeMarkerLogs(marker) {
  const entries = await readdir(DEFAULT_LOG_DIRECTORY).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const path = join(DEFAULT_LOG_DIRECTORY, entry);
    if ((await readFile(path, "utf8").catch(() => "")).includes(marker)) {
      await rm(path, { force: true });
    }
  }));
}
