#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  collectTfVars,
  maskLine,
  renderGithubEnvBlock,
  toEnvName,
  writeGithubEnv,
} from "../tfvars-to-github-env.mjs";

test("toEnvName lowercases only the TF_VAR_ suffix", () => {
  assert.equal(toEnvName("TF_VAR_PLATFORM_RG_NAME"), "TF_VAR_platform_rg_name");
  assert.equal(toEnvName("TF_VAR_Mixed_CASE"), "TF_VAR_mixed_case");
});

test("collectTfVars includes only TF_VAR_ entries and secrets win collisions", () => {
  const entries = collectTfVars(
    {
      TF_VAR_COLLISION: "secret=value\nsecond line",
      TF_VAR_PURETRACK_API_KEY: "unchanged-SECRET",
      GITHUB_TOKEN: "must-not-escape",
      github_token: "also-must-not-escape",
    },
    {
      TF_VAR_COLLISION: "var-loses",
      TF_VAR_ALLOWED_ORIGINS: '["https://a","https://b"]',
      TF_VAR_PLATFORM_RG_NAME: "rg",
      UNRELATED: "must-not-escape",
    },
  );

  assert.deepEqual(entries, [
    {
      name: "TF_VAR_allowed_origins",
      value: '["https://a","https://b"]',
      source: "var",
    },
    {
      name: "TF_VAR_collision",
      value: "secret=value\nsecond line",
      source: "secret",
    },
    { name: "TF_VAR_platform_rg_name", value: "rg", source: "var" },
    {
      name: "TF_VAR_puretrack_api_key",
      value: "unchanged-SECRET",
      source: "secret",
    },
  ]);
  assert.ok(entries.every(({ name }) => name.startsWith("TF_VAR_")));
});

test("renderGithubEnvBlock preserves hostile values behind a fresh delimiter", () => {
  const value = "a=b\n__GHENV_literal__\nEOF\n::set-output name=pwned::yes";
  const block = renderGithubEnvBlock("TF_VAR_hostile", value);
  const [opening, ...rest] = block.split("\n");
  const delimiter = opening.slice("TF_VAR_hostile<<".length);

  assert.match(delimiter, /^__GHENV_[0-9a-f]+__$/);
  assert.equal(value.includes(delimiter), false, "delimiter must not occur in the value");
  assert.equal(opening, `TF_VAR_hostile<<${delimiter}`);
  assert.equal(rest.join("\n"), `${value}\n${delimiter}`);
  assert.equal(block.match(/^TF_VAR_/gm)?.length, 1, "value cannot inject another env entry");
});

test("maskLine percent-encodes workflow-command metacharacters", () => {
  assert.equal(maskLine("50%\r\nnext"), "::add-mask::50%25%0D%0Anext");
});

test("writeGithubEnv masks every secret line before appending byte-verbatim heredocs", () => {
  const dir = mkdtempSync(join(tmpdir(), "tfvars-github-env-"));
  const githubEnv = join(dir, "github-env");
  const priorGithubEnv = process.env.GITHUB_ENV;
  const priorLog = console.log;
  const output = [];
  process.env.GITHUB_ENV = githubEnv;
  console.log = (line) => output.push(line);

  try {
    const secret = "line1\r\nEOF\n::set-output::";
    writeGithubEnv([
      { name: "TF_VAR_hostile", value: secret, source: "secret" },
      {
        name: "TF_VAR_allowed_origins",
        value: '["https://a","https://b"]',
        source: "var",
      },
    ]);

    assert.deepEqual(output, [
      "::add-mask::line1%0D%0A",
      "::add-mask::EOF%0A",
      "::add-mask::::set-output::",
    ]);

    const written = readFileSync(githubEnv, "utf8");
    const firstOpening = written.slice(0, written.indexOf("\n"));
    const firstDelimiter = firstOpening.slice("TF_VAR_hostile<<".length);
    assert.equal(secret.includes(firstDelimiter), false);
    assert.ok(written.includes(`TF_VAR_hostile<<${firstDelimiter}\n${secret}\n${firstDelimiter}\n`));
    assert.match(
      written,
      /TF_VAR_allowed_origins<<(__GHENV_[0-9a-f]+__)\n\["https:\/\/a","https:\/\/b"\]\n\1\n$/,
    );
    assert.equal(output.some((line) => line.includes("allowed_origins")), false);
  } finally {
    console.log = priorLog;
    if (priorGithubEnv === undefined) delete process.env.GITHUB_ENV;
    else process.env.GITHUB_ENV = priorGithubEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});
