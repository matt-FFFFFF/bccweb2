#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TF_VAR_PREFIX = "TF_VAR_";

export function toEnvName(key) {
  return `${TF_VAR_PREFIX}${key.slice(TF_VAR_PREFIX.length).toLowerCase()}`;
}

/**
 * Collect GitHub configuration as normalized Terraform environment entries.
 * Variables are inserted first; secrets replace matching variables so secret
 * provenance and masking are retained on collisions.
 */
export function collectTfVars(secretsObj, varsObj) {
  const entries = new Map();

  for (const [source, object] of [["var", varsObj], ["secret", secretsObj]]) {
    for (const [key, value] of Object.entries(object)) {
      if (!/^TF_VAR_/.test(key) || /^(?:GITHUB_TOKEN|github_token)$/.test(key)) continue;
      const name = toEnvName(key);
      entries.set(name, { name, value: String(value), source });
    }
  }

  return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function renderGithubEnvBlock(name, value) {
  let delimiter;
  do {
    delimiter = `__GHENV_${randomBytes(16).toString("hex")}__`;
  } while (value.includes(delimiter));
  return `${name}<<${delimiter}\n${value}\n${delimiter}`;
}

export function maskLine(value) {
  const encoded = value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  return `::add-mask::${encoded}`;
}

function linesWithTerminators(value) {
  return value.match(/.*?(?:\r\n|\r|\n|$)/gs).filter(Boolean);
}

export function writeGithubEnv(entries) {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) throw new Error("GITHUB_ENV is required");

  for (const entry of entries) {
    if (entry.source === "secret") {
      for (const line of linesWithTerminators(entry.value)) console.log(maskLine(line));
    }
    appendFileSync(githubEnv, `${renderGithubEnvBlock(entry.name, entry.value)}\n`, "utf8");
  }
}

function parseObject(name) {
  const raw = process.env[name] ?? "{}";
  const value = JSON.parse(raw);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${name} must contain a JSON object`);
  }
  return value;
}

export function main() {
  writeGithubEnv(collectTfVars(parseObject("SECRETS_JSON"), parseObject("VARS_JSON")));
}

const runningAsScript =
  import.meta.main ??
  (process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false);

if (runningAsScript) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
