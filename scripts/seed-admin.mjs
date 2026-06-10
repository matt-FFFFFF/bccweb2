#!/usr/bin/env node
/**
 * seed-admin.mjs
 *
 * Idempotent admin bootstrap for the docker-compose dev stack.
 *
 * Behaviour:
 *   - Reads `user-index.json` from the private container.
 *   - If `admin@bcc.local` already exists → log to STDERR (yellow) and exit 0.
 *   - Otherwise:
 *       1. Generate a random 16-char password.
 *       2. Compute a deterministic userId via `deterministicUuid("admin-user", ADMIN_EMAIL)`.
 *       3. Bcrypt-hash the password ONCE (cost 12).
 *       4. Write `auth/{userId}.json` with `emailVerified: true`.
 *       5. Write `users/{userId}.json` with `roles: ["Admin"]` and
 *          `acceptedTsCsVersion: TS_CS_VERSION` (so the SPA doesn't block on T&Cs).
 *       6. Re-read `user-index.json` (refresh in case of race), merge in the new
 *          entry, write back.
 *       7. Print the password to STDERR three times (ANSI yellow + bold) so it's
 *          visible above docker-compose noise.
 *       8. Write `.dev-credentials` (chmod 600) with the credentials so other
 *          scripts (e.g. `make e2e`) can pick them up.
 *
 * Output rules:
 *   - All status / password output goes to STDERR. STDOUT stays clean so
 *     compose log integration (T14) can redirect freely.
 *   - The password is NEVER written to a blob — STDERR + `.dev-credentials` only.
 *
 * Usage:
 *   node scripts/seed-admin.mjs
 *
 * Env (all optional, sensible Azurite defaults):
 *   BLOB_CONNECTION_STRING          Azurite/Azure connection string
 *   BLOB_PRIVATE_CONTAINER_NAME     Defaults to "data-private"
 */

import {
  getPrivateContainer,
  readJson,
  writeJson,
  precomputeBcryptHash,
  deterministicUuid,
} from "./lib/blobSeed.mjs";
import {
  ADMIN_EMAIL,
  DEV_CREDENTIALS_PATH,
  TS_CS_VERSION,
} from "./lib/loadTestConsts.mjs";
import { randomBytes } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const ANSI_YELLOW_BOLD = "\x1b[1;33m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RESET = "\x1b[0m";

function logYellow(line) {
  process.stderr.write(`${ANSI_YELLOW}${line}${ANSI_RESET}\n`);
}

function logYellowBold(line) {
  process.stderr.write(`${ANSI_YELLOW_BOLD}${line}${ANSI_RESET}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const privateContainer = getPrivateContainer();

  const existingIndex =
    (await readJson(privateContainer, "user-index.json")) ?? {};

  if (existingIndex[ADMIN_EMAIL]) {
    logYellow(
      `=== BCC ADMIN: ${ADMIN_EMAIL} already exists. Run 'docker compose down -v' to regenerate. ===`
    );
    process.exit(0);
  }

  // Cold-run path — create the admin.
  const password = randomBytes(12).toString("base64url").slice(0, 16);
  const userId = deterministicUuid("admin-user", ADMIN_EMAIL);
  const now = new Date().toISOString();

  // ONE bcrypt call (cost 12 → ~250-400ms).
  const passwordHash = await precomputeBcryptHash(password);

  await writeJson(privateContainer, `auth/${userId}.json`, {
    passwordHash,
    emailVerified: true,
    createdAt: now,
  });

  await writeJson(privateContainer, `users/${userId}.json`, {
    id: userId,
    email: ADMIN_EMAIL,
    roles: ["Admin"],
    createdAt: now,
    acceptedTsCsVersion: TS_CS_VERSION,
  });

  // Re-read (refresh) the index to minimise the race window with any
  // concurrent writer, then merge in our entry and write back.
  const refreshedIndex =
    (await readJson(privateContainer, "user-index.json")) ?? {};
  refreshedIndex[ADMIN_EMAIL] = userId;
  await writeJson(privateContainer, "user-index.json", refreshedIndex);

  // Print the password 3x to STDERR in bold yellow so it's hard to miss in
  // docker-compose logs / scrollback.
  const passwordLine = `=== BCC ADMIN PASSWORD: ${password} (email: ${ADMIN_EMAIL}) ===`;
  for (let i = 0; i < 3; i++) {
    logYellowBold(passwordLine);
  }

  // Persist credentials for downstream scripts (e2e, smoke tests). chmod 600
  // because this file contains a plaintext password.
  writeFileSync(
    DEV_CREDENTIALS_PATH,
    `ADMIN_EMAIL=${ADMIN_EMAIL}\nADMIN_PASSWORD=${password}\n`
  );
  chmodSync(DEV_CREDENTIALS_PATH, 0o600);
}

main().catch((err) => {
  process.stderr.write(
    `seed-admin: ${err?.stack ?? err?.message ?? String(err)}\n`
  );
  process.exit(1);
});
