// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { redactLoadTestOutput } from "../lib/loadTestOutputRedaction.mjs";

test("phase-log redaction removes credentials while retaining diagnostics", () => {
  // Given
  const output = [
    "HTTP 401 request failed",
    'body={"accessToken":"secret-access","refreshToken":"secret-refresh","password":"secret-password"}',
    "Authorization: Bearer secret-bearer",
    "AccountKey=secret-storage-key;BlobEndpoint=http://worker.invalid;",
    "ADMIN_PASSWORD=secret-admin",
    "=== BCC ADMIN PASSWORD: secret-seeded (email: admin@bcc.local) ===",
  ].join("\n");

  // When
  const redacted = redactLoadTestOutput(output);

  // Then
  assert.match(redacted, /HTTP 401 request failed/);
  assert.doesNotMatch(redacted, /secret-access|secret-refresh|secret-password|secret-bearer|secret-storage-key|secret-admin|secret-seeded/u);
  assert.match(redacted, /\[REDACTED\]/u);
});
