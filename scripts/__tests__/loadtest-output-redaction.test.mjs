// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { redactLoadTestOutput } from "../lib/loadTestOutputRedaction.mjs";
import { runLoadTestOrchestration } from "../lib/loadTestOrchestration.mjs";

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

test("redaction removes Azure SAS and connection credentials case-insensitively", () => {
  // Given
  const output = [
    "GET https://worker.invalid/blob/file?sv=2024-11-04&sp=rw&se=2099-01-01&sig=secret-sas&safe=count",
    "GET https://worker.invalid/blob/file?S%69G=encoded-secret&SPR=https",
    "SharedAccessSignature=sv=2024&sig=shared-secret;BlobEndpoint=https://worker.invalid;",
    "SharedAccessKey=shared-key;AccountName=devstoreaccount1;",
    "SAS_TOKEN=?sv=2024&sig=env-secret",
    "DefaultEndpointsProtocol=https;AccountKey=account-secret;EndpointSuffix=core.windows.net",
  ].join("\n");

  // When
  const redacted = redactLoadTestOutput(output);

  // Then
  assert.doesNotMatch(redacted, /secret-sas|encoded-secret|shared-secret|shared-key|env-secret|account-secret/u);
  assert.match(redacted, /worker\.invalid\/blob\/file/);
  assert.doesNotMatch(redacted, /safe=count/u);
});

test("redaction removes generic token JSON and bare JWT while preserving metrics", () => {
  // Given
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwaWxvdCJ9.signature-secret";
  const output = `phase=verify durationMs=123 count=185 {"token":"token-secret"} jwt=${jwt}`;

  // When
  const redacted = redactLoadTestOutput(output);

  // Then
  assert.doesNotMatch(redacted, /token-secret|signature-secret/u);
  assert.match(redacted, /phase=verify durationMs=123 count=185/);
});

test("redaction removes URL credentials and colon or encoded SAS assignments", () => {
  // Given
  const output = [
    "https://user:password-secret@worker.invalid/path?S%2569G=double-secret&safe=count",
    "sas_token: colon-secret",
    "Access_Token = assignment-secret",
    "SharedAccessSignature = sv%3D2024%26sig%3Dencoded-connection-secret",
  ].join("\n");

  // When
  const redacted = redactLoadTestOutput(output);

  // Then
  assert.doesNotMatch(redacted, /password-secret|double-secret|colon-secret|assignment-secret|encoded-connection-secret/u);
  assert.match(redacted, /worker\.invalid\/path/);
  assert.doesNotMatch(redacted, /safe=count/u);
});

test("redaction removes unquoted generic token and password assignments", () => {
  // Given
  const output = "token=equals-secret token: colon-secret accessToken = camel-secret password=plain-secret password: colon-password";

  // When
  const redacted = redactLoadTestOutput(output);

  // Then
  assert.doesNotMatch(redacted, /equals-secret|colon-secret|camel-secret|plain-secret|colon-password/u);
});

test("redaction removes Authorization Bearer with colon or equals separators", () => {
  // Given
  const output = [
    "Authorization=Bearer auth-equals-marker",
    "authorization : bearer auth-colon-marker",
    'AUTHORIZATION = "Bearer auth-quoted-marker"',
  ].join("\n");

  // When
  const redacted = redactLoadTestOutput(output);

  // Then
  assert.doesNotMatch(redacted, /auth-equals-marker|auth-colon-marker|auth-quoted-marker/u);
  assert.match(redacted, /Authorization=Bearer \[REDACTED\]/u);
});

test("redaction removes bare Bearer tokens without hiding the word alone", () => {
  // Given
  const output = 'Bearer bare-token-marker\nBearer "quoted-bearer-marker"\nBearer';

  // When
  const redacted = redactLoadTestOutput(output);

  // Then
  assert.doesNotMatch(redacted, /bare-token-marker|quoted-bearer-marker/u);
  assert.match(redacted, /^Bearer$/mu);
});

test("SAS-bearing URLs redact every query value including unknown future keys", () => {
  // Given
  const output = [
    "GET https://worker.invalid/blob/file?sv=version-marker&SIG=sas-marker&custom=future-marker&count=185",
    "GET https://worker.invalid/blob/file?S%2569G=encoded-sas-marker&FutureKey=encoded-future-marker",
    "GET https://worker.invalid/health?count=185&durationMs=42",
  ].join("\n");

  // When
  const redacted = redactLoadTestOutput(output);

  // Then
  assert.doesNotMatch(redacted, /version-marker|sas-marker|future-marker|encoded-sas-marker|encoded-future-marker/u);
  assert.match(redacted, /https:\/\/worker\.invalid\/blob\/file\?/u);
  assert.match(redacted, /https:\/\/worker\.invalid\/health\?count=185&durationMs=42/u);
});

test("Authorization, bare Bearer, and mixed SAS values never persist in status", async () => {
  // Given
  const records = [];
  const leaked = "Authorization=Bearer status-auth-marker Bearer status-bare-marker https://worker.invalid/blob?sig=status-sas-marker&custom=status-future-marker";

  // When
  await runLoadTestOrchestration({
    runPhase: async () => ({ exitCode: null, signal: null, error: leaked, timedOut: false }),
    inspectCheckpoint: async () => false,
    record: async (value) => records.push(JSON.stringify(value)),
    now: () => 1,
  });

  // Then
  assert.doesNotMatch(records.join("\n"), /status-auth-marker|status-bare-marker|status-sas-marker|status-future-marker/u);
});
