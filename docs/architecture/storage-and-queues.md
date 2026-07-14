# Architecture: Storage and Queues

Human-facing reference for how bccweb2 stores data and moves work asynchronously.
There is no database: everything lives in Azure Blob Storage, and background work
runs over Azure Storage Queues in the same storage account. This doc is linked from
[AGENTS.md](../../AGENTS.md) and falls under its evergreen clause: if it drifts from
the code, fix it in the same change that revealed the drift.

## Containers

Two containers, created by [`scripts/init-storage.mjs`](../../scripts/init-storage.mjs):

- **`data`** (public, `publicAccess = "blob"`) — the SPA reads these blobs directly via
  `VITE_BLOB_BASE_URL` (dev: Vite proxies `/blob/* → /devstoreaccount1/data/*`). Contains
  indexes and derived data such as `rounds.json`, `seasons.json`, `seasons/{year}.json`,
  `results/{year}.json`, `pilots.json`, `clubs.json`, `club-teams.json`, `sites.json`, and
  `manufacturers.json`. **Never put PII fields
  here** — a PR-gated [privacy scanner](../../scripts/privacy-scan.mjs) fails CI if PII
  leaks into this container.
- **`data-private`** (private, API-only via JWT) — families include `rounds/{uuid}.json`,
  `pilots/{uuid}.json` (PII), `clubs/{uuid}.json`, `club-teams/{uuid}.json`,
  `sites/{uuid}.json`, `config.json`, `users/{uuid}.json`, `user-index.json`,
  `auth/{uuid}.json`, `auth/tokens/{hash}.json`, `round-briefs/{uuid}.{json,pdf}`,
  `frequencies/*`, `pilot-season-clubs/*`, `season-clubs/*`, `flight-igcs/*`,
  signature/wording ledgers, PureTrack records, and `rescore-jobs/*` status blobs.

Atomic read-modify-write on either container uses 30-second blob leases —
`withLease()` (public) / `withPrivateLease()` (private) in
[`apps/api/src/lib/blob.ts`](../../apps/api/src/lib/blob.ts).

## Schema layer

Schema-backed domain blob families have canonical Zod schemas in `packages/schemas` and
use `readJson(client, Schema)` plus `writeJson` / `writePrivateJson` (see
`apps/api/src/lib/blobJson.ts`). Operational/control records such as rescore status blobs
may use documented raw JSON and are outside `BLOB_SCHEMA_MODE`; raw helpers also remain
valid for non-JSON artifacts and explicitly justified lease/index operations.

- **`BLOB_SCHEMA_MODE`** (Function App env): `observe` (default) heals bad shapes in
  memory and emits telemetry only; `enforce` writes schema-parsed output, stripping
  unknown keys for `.strip()` objects and rejecting them for `.strict()` objects. This
  is an app setting, not a redeploy — flip it per `docs/runbooks/alerts.md`.
- **WingClass break-glass**: adding a `WingClass` requires, in order, types → schema →
  API deploy → admin UI emitting the new key. Doing it out of order means `enforce`
  mode will reject or strip the field.
- **`DATA_SHAPE_INVALID`**: a server-side data-invariant violation. The response body is
  `{error, path, schema}` — never field values (actual values are logged server-side
  only).
- **Test-fixture raw access**: `apps/api/src/__tests__/helpers/seed.ts` prefers handlers,
  but its banner allows bootstrap, controlled fixture overrides, deliberately corrupt
  negative fixtures, and assertion reads. A new category must update the banner and this
  section.

## Storage Queues

Ten queues, same storage account as the blobs, created by `init-storage.mjs` — across
five families, each a main queue plus a `-poison` dead-letter queue
(`maxDequeueCount=5` in `host.json`):

| Family | Main queue | Poison queue |
|---|---|---|
| Brief PDF | `round-brief-pdf` | `round-brief-pdf-poison` |
| Sign-to-fly reflect | `signtofly-reflect` | `signtofly-reflect-poison` |
| Rescore | `rescore-jobs` | `rescore-jobs-poison` |
| PureTrack group | `round-puretrack-group` | `round-puretrack-group-poison` |
| IGC validation | `igc-validation` | `igc-validation-poison` |

The Functions host dead-letters only messages whose final invocation still throws.
Workers normally catch terminal domain failures and record status/telemetry instead, so
poison queues are fallbacks for uncaught host/handler failures rather than a complete
inventory of jobs that exhausted ordinary retries.

`init-storage.mjs` creates all ten uniformly and fatally: if the Queue service is
unreachable the script throws and exits non-zero. Blob containers are created earlier in
the same run, so a queue-service outage still surfaces as a hard failure rather than a
partial success.

**Connection invariant**: every producer (`apps/api/src/lib/queue.ts` and
`apps/api/src/lib/rescoreJob.ts`) and every `app.storageQueue` trigger uses the
`AzureWebJobsStorage` connection setting — the only setting carrying a `QueueEndpoint` in
local/Docker. `BLOB_CONNECTION_STRING` is blob-only; using it would silently break queueing.

**Queue privacy**: `privacy-scan.mjs` does not cover Storage Queues. The compensating
control is strict, `.strict()` job schemas in `apps/api/src/lib/queue.ts` and
`apps/api/src/lib/rescoreJob.ts`:

- `BriefPdfJobSchema` — only `{roundId, briefVersion, pdfAttemptId}`.
- `SignToFlyReflectJobSchema` — only `{roundId}`.
- `PureTrackGroupJobSchema` — only `{roundId, attemptId}`.
- `RescoreJobMessageSchema` — only `{jobId, roundId, requestedAt}`.
- `IgcValidationJobSchema` — only `{roundId, teamId, place, flightId, validationAttemptId}`.

Any extra key is rejected at serialisation time, so PII can never enter these messages.

### Brief PDF flow

`POST /api/rounds/{id}/lock` sets `brief.pdfStatus = "pending"` and a fresh
`brief.pdfAttemptId` on the round blob, then enqueues
`{roundId, briefVersion, pdfAttemptId}`. The `briefPdf` queue-trigger consumer
(`apps/api/src/functions/briefPdf.ts`) renders and uploads the PDF, then atomically flips
`pdfStatus` to `ready`; only after that commit succeeds does it send configured email.
Readiness therefore confirms the artifact commit, not email delivery. Correctness is
guarded by `pdfAttemptId` plus an atomic compare-and-set commit
(`commitBriefPdfReady`) — **not** by `briefVersion` or `visibilityTimeout`. Status values:
`pending | processing | ready | failed`. Unlocking clears the PDF status fields.

### Sign-to-fly reflect flow

The sign endpoints enqueue `{roundId}` onto `signtofly-reflect`. The `signaturesReflect`
queue-trigger consumer (`apps/api/src/functions/signaturesReflect.ts`) re-materializes
`slot.signToFly` for the whole round by replaying the signature ledger (`signTofly/*`),
then writes the updated round blob. This keeps the HTTP response fast even though the
full-round recompute can be expensive. Operator recovery:
`POST /api/rounds/{id}/reflect-sign-to-fly` (Admin/scoped-coord) re-runs the reflect
synchronously and returns the corrected round.

### Rescore flow

Only the Admin rescore path (`POST /api/rounds/{id}/rescore`) enqueues
`{jobId, roundId, requestedAt}` onto `rescore-jobs` — single-pilot IGC upload stays
synchronous and never touches this flow. The `rescoreWorker` queue-trigger consumer
(`apps/api/src/functions/rescoreWorker.ts`) re-scores the round via the IGC-based scoring
path, writes the result, and updates `rescore-jobs/{jobId}.json`
(`queued | running | completed | partial | failed`). The Admin UI polls
`GET /api/rounds/{id}/rescore/{jobId}` for progress. Normal job failures are caught,
ACKed, and recorded as `failed` on the job status blob — they are **not** dead-lettered.
`rescore-jobs-poison` (provisioned in Terraform + `init-storage.mjs`) is a safety net for
catastrophic/uncaught host-level failures only. For failure triage, read the job status
blob plus App Insights.

### PureTrack group flow

Both the lock endpoint (`POST /api/rounds/{id}/lock`) and
`POST /api/rounds/{id}/puretrack/create-groups` set `round.pureTrack.status = "pending"`
and a fresh `pureTrack.attemptId`, then enqueue `{roundId, attemptId}` onto
`round-puretrack-group`. The `puretrackGroups` queue-trigger consumer
(`apps/api/src/functions/puretrackGroups.ts`) takes a global PureTrack mutation guard,
replaces then re-creates the round's PureTrack groups, and commits via the `attemptId` +
owner-token compare-and-set `commitPureTrackReady`
(`apps/api/src/lib/puretrackStatus.ts`), which flips `pureTrack.status` to `ready` only
while it is still `processing`. Status values: `pending | processing | ready | failed`.
Only failures that escape the worker after the final dequeue reach the poison queue.

### IGC validation flow

IGC upload and revalidation (`apps/api/src/functions/igc.ts`) set the flight's
`validation.signature = "pending"`, stamp a fresh `validationAttemptId`, and enqueue
`{roundId, teamId, place, flightId, validationAttemptId}` onto `igc-validation`. The
`igcValidationWorker` queue-trigger consumer
(`apps/api/src/functions/igcValidationWorker.ts`) re-reads the round, drops the message
(ACK, no-op) if the flight or its `validationAttemptId` has since moved on: a newer
upload or re-validation supersedes it, and reuses a durable
`readValidationResult(validationAttemptId)` record instead of re-calling FAI if one
already exists for this attempt.

Otherwise it acquires a single global blob-lease guard
(`igc-validation/active.json`, `acquireIgcValidationGuard`/`releaseIgcValidationGuard`
in `apps/api/src/lib/igcValidationJob.ts`) so at most one call to the FAI validator runs
at a time, paces itself to at least 2 seconds since the last call
(`paceBeforeFaiCall`), and only then re-reads `config.json`. If
`flightSignatureValidationEnabled` has been switched off since the message was queued,
the worker records `signature: "unverified", faiStatus: "DISABLED"` and skips the FAI
call entirely; see `docs/runbooks/privacy.md` for the accepted sub-second TOCTOU window
this leaves. Otherwise it calls
`validateIgcSignature` (`apps/api/src/lib/faiVali.ts`) against the flight's immutable
`igcPath` bytes, persists the outcome via `writeValidationResult` (create-only,
durable) before releasing the guard, then commits the result onto the round under a
private lease, re-scores via `scoreRoundEnforcingValidation`, and, for a `Complete`
round, it calls `recomputeSeason`. If the `recomputeSeason` step fails it is logged and
ACKed rather than retried, since the terminal validation result and round score are
already committed; an operator repairs the published league via
`POST /api/manage/rounds/{id}/recompute` (see `docs/runbooks/privacy.md` for the
outbound-egress and toggle implications of this flow).

Transport failures talking to FAI (timeout, 5xx, non-JSON, oversized file) are mapped to
a terminal `unverified` result and ACKed; they never retry the FAI call. Only a failure
in the commit-phase lease write throws, so the host retries; that retry finds the
durable `writeValidationResult` record and skips FAI again. After `maxDequeueCount:5`
such retries dead-letter to `igc-validation-poison` as a host-crash safety net.

## Related runbooks

- `docs/runbooks/alerts.md` — `blob.healed` triage, `BLOB_SCHEMA_MODE` flip procedure.
- `docs/runbooks/privacy.md` — privacy incident response.
- `docs/runbooks/load-testing.md` — load-test topology and gates.
