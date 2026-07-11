// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { isAbsolute, relative, resolve } from "node:path";
import { lstat as defaultLstat } from "node:fs/promises";
import { dirname, sep } from "node:path";

export function assertLoadTestTarget(baseUrl, dedicatedStack = false) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error("BCC_API_BASE_URL must be a valid URL", { cause: error });
  }
  const host = url.hostname.toLowerCase();
  if (url.username || url.password) throw new Error("BCC_API_BASE_URL must not contain credentials");
  const tokens = host.split(/[.-]/u).filter(Boolean);
  if (tokens.some((token) => token.startsWith("prod") || token === "production")) {
    throw new Error("refusing production-looking BCC_API_BASE_URL");
  }
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!loopback && !tokens.some((token) => token === "loadtest" || token === "staging")) {
    throw new Error("remote BCC_API_BASE_URL hostname must contain loadtest or staging");
  }
  if (!loopback && dedicatedStack !== true) {
    throw new Error("remote load test requires dedicated stack confirmation LOADTEST_DEDICATED_STACK=1");
  }
}

export function resolveLoadTestArtifactPath(directory, requestedPath, defaultName) {
  if (requestedPath !== undefined && isAbsolute(requestedPath)) {
    throw new Error("load-test artifact path must be relative");
  }
  const path = resolve(directory, requestedPath ?? defaultName);
  const relativePath = relative(directory, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("load-test artifact path must remain inside logs/load-test");
  }
  return path;
}

async function rejectSymlinks(root, path, lstat) {
  const relativePath = relative(root, path);
  let current = root;
  for (const component of relativePath.split(sep)) {
    current = resolve(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`load-test artifact path contains symbolic link ${current}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function assertLoadTestArtifactPathsSafe(root, paths, options = {}) {
  const { lstat = defaultLstat } = options;
  for (const path of paths) {
    await rejectSymlinks(root, dirname(path), lstat);
    await rejectSymlinks(root, path, lstat);
  }
}
