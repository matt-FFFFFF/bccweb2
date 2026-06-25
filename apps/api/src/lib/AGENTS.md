# apps/api/src/lib — API helpers

Usage contracts for the shared helpers. Root [AGENTS.md](../../../../AGENTS.md) lists
these by name; this file is the **cheat sheet** so you don't re-read the source.

## blob.ts — clients + leases

- `getBlobClient/getBlockBlobClient(path)` (public), `getPrivateBlobClient/...` (private).
- `readBlob(client)` raw JSON parse (missing → Azure 404). `writeBlob(path,data,leaseId?)`.
- `writePrivateBlob(path,data,leaseId?,{ifNoneMatch?})` — `ifNoneMatch:"*"` = create-only.
- `ensureJsonIndexBlob` / `ensurePrivateJsonIndexBlob(path,seed)` — create-only seed (409/412 = no-op).
- `withLease` / `withPrivateLease(path, fn)` — 30s lease, passes `leaseId`, best-effort release.
- `...LeaseRetry(...)` retries 409/412 conflicts; `...LeaseRenewing(...)` for long work →
  throws `LeaseRenewalFailedError` if renew fails.
- `resetBlobSingletons()` — **test-only**; clears cached service/container clients.
- Gotcha: release failure is telemetry-only; the fn's result/error wins.

## blobJson.ts — schema-validated JSON (the real read/write helpers live HERE, not blob.ts)

- `readJson(client,schema,path)` — validates vs zod, throws `BlobShapeError`, emits
  `blob.healed` when raw JSON healed on read.
- `writeJson` / `writePrivateJson(path,schema,data,leaseId?,opts?)` — validate-first;
  `observe` logs bad shapes, `enforce` strips/rejects before delegating to `writeBlob`.

## http.ts

- `HttpError(status,code,detail?,headers?)`, `BlobShapeError(path,schemaName,issues)`.
- `withErrorHandler(handler)` — `HttpError`→`{error,code,requestId,detail?}`,
  `BlobShapeError`→`500 DATA_SHAPE_INVALID`, else generic 500. Any returned `status>=400` is normalized too.

## auth.ts / authHelpers.ts

- `getCallerIdentity(req)` — validates access JWT, resolves/creates user → `CallerIdentity | null`
  (bad/missing token = `null`; caller chooses 401 vs 403).
- `unauthorizedResponse()` (401), `forbiddenResponse()` (403).
- `signAccessToken` (1h), `signRefreshToken` (30d), `verifyRefreshToken`.
- `hashPassword`/`verifyPassword` (bcrypt; `TEST_BCRYPT_COST` honored only in test env).
- `generateShortLivedToken` / `consumeShortLivedToken` — one-shot via ETag CAS →
  `TokenNotFound/Expired/AlreadyConsumed` errors. `lookupUserByEmail`, `getAppUrl()`.

## recompute.ts

- `updateRoundsIndex(round)` — upsert `rounds.json` summary (leased RMW).
- `recomputeSeason(year)` — dedupes concurrent recomputes; rebuilds `seasons/{year}.json`,
  `results/{year}.json`, `rounds.json`. Uses `.lock` + `.recompute.lock`; may leave `.tmp` for forensics.

## telemetry.ts / telemetryRedactor.ts

- `setup()`: one-time App Insights init, **call early** (processors attach only here via `setAzureMonitorOptions`), no-op without env. `getTelemetryClient()`, `resetForTests()`.
- `PII_FIELDS` (must match `scripts/lib/pii.mjs`), `redactObject(obj,fields?)`.
- `PiiRedactingSpanProcessor`: drops successful `Functions.health` spans (retains failed ones) and redacts PII from request/dependency span attributes (PII_FIELDS + `OTEL_PII_SPAN_ATTRS`).
- `PiiRedactingLogRecordProcessor`: redacts PII from trackEvent/trackTrace log record attributes.

## signTofly/ — sign-to-fly workflow

- `ledger.ts` — signature path builders, `read/write/listSignaturesForRound`,
  `getLatestSignature`, `buildSignaturePayload` (brief+wording hash, IP, UA), `extractIp`
  (`x-forwarded-for` → `x-azure-clientip`). Writes are create-only; path version = source of truth.
- `wording.ts` — `getActiveWording`/`getWording(version)`/`addWordingVersion`/`listWordingVersions`;
  missing pointer → `503 WORDING_NOT_SEEDED`.
- `briefVersion.ts` — `MATERIAL_BRIEF_FIELDS`, `computeBriefHash`, `diffMaterialFields`
  (non-material edits don't change the hash).
- `invalidate.ts` — `invalidatePriorSignToFlyFlags(...)` clears `slot.signToFly` when latest
  signature predates current brief version.
- `auditLog.ts` — `appendAuditLine(category,payload)` append-only NDJSON (`audit/<cat>-YYYY-MM-DD.jsonl`).
