// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assertSafeCredentialOwner } from "../lib/devCredentials.mjs";

test("root api-init accepts only the exact host-owned bind credential", () => {
  // Given
  const hostOwned = { uid: 1_000, gid: 1_000 };

  // When / Then
  assert.doesNotThrow(() => assertSafeCredentialOwner(
    hostOwned,
    "/workspace/.dev-credentials",
    { currentUid: 0, expectedUid: 1_000, expectedGid: 1_000 },
  ));
  assert.throws(() => assertSafeCredentialOwner(
    hostOwned,
    "/workspace/.dev-credentials",
    { currentUid: 0, expectedUid: 2_000, expectedGid: 2_000 },
  ), /owned by the current user or configured host user/u);
});

test("docker-up passes host ownership to api-init without exposing ADMIN_PASSWORD", async () => {
  // Given / When
  const [makefile, compose] = await Promise.all([
    readFile(resolve("Makefile"), "utf8"),
    readFile(resolve("docker-compose.yml"), "utf8"),
  ]);

  // Then
  const dockerRecipe = makefile.match(/^docker-up:.*\n((?:\t.*\n)+)/mu)?.[1] ?? "";
  assert.match(dockerRecipe, /BCC_HOST_UID=.*id -u/u);
  assert.match(dockerRecipe, /BCC_HOST_GID=.*id -g/u);
  assert.match(compose, /BCC_HOST_UID:\s*"\$\{BCC_HOST_UID/u);
  assert.match(compose, /BCC_HOST_GID:\s*"\$\{BCC_HOST_GID/u);
  assert.doesNotMatch(compose, /ADMIN_PASSWORD:/u);
});
