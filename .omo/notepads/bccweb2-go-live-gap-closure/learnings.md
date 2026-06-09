# Learnings — bccweb2-go-live-gap-closure

## Baseline commit
- 8b596df chore: baseline snapshot of in-progress rewrite work (51 files)
- All subsequent task work diffs against this commit
- Treat plan as fresh start (no tasks completed yet)

## Repo conventions (from AGENTS.md)
- Monorepo (npm workspaces): apps/api, apps/web, packages/types, packages/scoring
- Node 20.20.2, ESM, NodeNext, strict TypeScript
- Build order: types -> scoring -> api ; types -> web
- After `make clean`, tsbuildinfo files deleted (prevents stale incremental builds)
- Azure Functions v4 HTTP API; React 18 SPA via Vite 5
- No DB: two Azure Blob containers - `data` (public Blob) + `data-private` (private)
- Bespoke HS256 JWT (env JWT_SECRET); roles: Admin / RoundsCoord (scoped via clubId) / Pilot
- Vitest 4.1.2 already at root; workspace mode

## Task 4 web vitest notes
- Alias strategy: vitest.config.ts resolves `@bccweb/types` directly to `packages/types/src` so source-only type edits are picked up without rebuilding dist
- Home smoke test assertion: `Advance British Club Challenge (BCC)`

## Test infrastructure ALREADY scaffolded in baseline
- `vitest.workspace.ts` = `["packages/scoring", "apps/api"]`
- `apps/api/vitest.config.ts` exists (sequence.concurrent=false, 15s testTimeout)
- `apps/api/src/__tests__/helpers/` includes:
  - `setup.ts` — mocks @azure/functions app.http, exposes `getRegisteredHandler`, mocks email module
  - `azurite.ts` — CONNECTION_STRING, beforeAll creates `data` + `data-private` containers
  - `seed.ts`, `api.ts` — fixture helpers
- Existing tests: `blob-container-routing.test.ts`, `blob-split-security.test.ts`
- `packages/scoring/src/__tests__/scoring.test.ts` (16 tests)
- Task 3 should only ADD a smoke health test (and verify vitest.workspace + package.json scripts)
- Task 4 (apps/web vitest) is greenfield — `apps/web/src/__tests__/` does NOT exist

## Types ALREADY present (`packages/types/src/index.ts`)
- 380 lines
- RoundStatus union already includes BriefComplete (Task 1 does NOT need to add it)
- PilotSeasonClub interface already present (Task 1 still needs to add SeasonClub — different thing)
- Already has: UserRole, CoachType, PilotRatingValue, WingClass, RoundStatus, PilotSlotStatus, ScoringType, Config, User, UserIndex, CallerIdentity, ClubRef/SiteRef/ManufacturerRef, Club*, ClubTeam*, Site*, Manufacturer, PilotRating, Person, PilotSeasonClub, Pilot*, Season*, LeagueEntry, RoundSummary, PilotSnapshot, Flight, PilotSlot, Team, Round, RoundBrief*, BriefPilotEntry, BriefTeamEntry, RoundResult, SeasonResults
- Task 1 still needs to add: Signature, BriefVersion, SignToFlyWording, SeasonClub, Frequency, captainPilotId on Team, audit triple (createdAt/updatedAt/updatedBy) on Round/Pilot/Club/Site/SeasonClub/Team/Signature/BriefVersion, legacyId? where missing

## Existing API helpers (touched in baseline; not yet hardened)
- `apps/api/src/lib/blob.ts:116` exports `withLease` (30s lease, no renewal helper yet)
- `apps/api/src/lib/recompute.ts:76` exports `recomputeSeason` (non-atomic per audit)
- `apps/api/src/lib/authHelpers.ts:104` exports `consumeShortLivedToken` (non-atomic per audit)
- `apps/api/src/functions/pilots.ts:287` has `upsertPilotInIndex` (no lease)
- `apps/api/src/functions/roundsMutate.ts:615-633` writes `wingManufacturer` as STRING; `scripts/migrate/migrate.mjs:495-505` writes it as OBJECT — Task 24 reconciles

## Existing migration script (`scripts/migrate/migrate.mjs`)
- `mapStatus()` at line ~95 handles legacy strings ("brief complete", "submitted", "verified", "deleted") - Task 2 should keep parity
- Uses `uuidv4()` in 12 sites (lines 162, 176, 188, 211, 249, 308, 351, 450, 466, 514) — Task 8 wraps these in `getOrCreateUuid()` keyed by SQL id
- ID maps are in-memory only (clubUuid, siteUuid, seasonUuid, pilotUuid, roundUuid, teamUuid, mfrUuid, ratingUuid) — Task 8 persists them
- `DRY_RUN` env-var flag exists informally — Task 8 formalizes as CLI flag
- Writes `pilots.json` with emails embedded — Task 21 strips this PII

## Existing IaC (baseline already touched these)
- `iac/storage.tf` (118 lines diff in baseline) — Task 6 audit not yet applied (need to verify GRS/versioning/soft-delete/container-retention)
- `iac/functions.tf` still has JWT_SECRET inlined — Task 7 moves to KV reference
- `iac/acs.tf` exists — Task 51 needs DNS verification records
- No App Insights resource yet — Task 46/47

## Git identity (used for owner-approval artifacts)
- Name: Matt White
- Email: 16320656+matt-FFFFFF@users.noreply.github.com

## NEVER
- Never use bun for CI scripts (use npm)
- Never `terraform destroy` anything from a worker
- Never strip the data container's public-read access
- Never use emojis in code unless explicitly requested
- Never write to .omo notepad files via Write (append-only); use `cat >> file <<EOF` or Edit-append

## Task 2 — Round status normalization
- Added canonical normalizeStatus() in packages/types/src/status.ts and re-exported it from packages/types/src/index.ts.
- Mirrored the helper in scripts/lib/status.mjs and delegated scripts/migrate/migrate.mjs mapStatus() to it while preserving behavior.
- Wired normalizeStatus() into apps/api/src/functions/roundsMutate.ts for create/update round writes; invalid inputs now return 400 INVALID_STATUS.
- Added packages/types Vitest setup plus status normalization tests; verified packages/types build, packages/types test, and packages/scoring test all pass.

## Task 3 notes
- Health smoke test uses the registry from `apps/api/src/__tests__/helpers/setup.ts` by importing `../functions/health.js` and calling `getRegisteredHandler("health")`.
- Minimal invocation worked with `makeRequest({ method: "GET" })` plus a plain `{ log, functionName }` context stub; no live Functions host was needed.
- Health handler currently returns `{ status: 200, jsonBody: { status: "ok", timestamp } }`, so the test only asserts the stable `status` field.

## Task 7 notes — JWT_SECRET → Key Vault
- Added `hashicorp/azurerm ~> 3.0` provider alongside existing `Azure/azapi ~> 2.8`; azurerm v3.117.1 was already cached in `.terraform/`. No `subscription_id` required in provider block for 3.x (auto-discovers from `az login` context or `ARM_SUBSCRIPTION_ID` env var).
- Key Vault reference syntax chosen: `@Microsoft.KeyVault(VaultName=<name>;SecretName=<secret>)` — the VaultName+SecretName form (not SecretUri form). Both are supported by the Azure Functions runtime; VaultName form is easier to read and does not hard-code the vault hostname.
- The Function App's system-assigned managed identity is exposed via `azapi_resource.function_app.identity[0].principal_id` — azapi 2.x treats `identity {}` as a first-class computed block, no need to add `"identity"` to `response_export_values`.
- `azurerm_role_assignment` auto-generates the UUID name if omitted — no `random` provider needed.
- NO `azurerm_key_vault_secret` resource for `jwt-secret` — confirmed by `terraform show -json plan.binary | jq '... | length'` returning `0`.
- `terraform plan` shows JWT_SECRET value as `@Microsoft.KeyVault(VaultName=kv-bccweb-prod;SecretName=jwt-secret)` — evidence at `.omo/evidence/task-7-kv-ref-in-plan.txt`.
- Seed script (`scripts/iac/seed-secrets.sh`) uses `az keyvault secret show ... 2>/dev/null | grep -q .` for idempotent existence check before writing; generates secret via `openssl rand -base64 64 | tr -d '\n'`.
- ACS connection string left TF-managed for now (Wave 7 deepens); seed script has a placeholder block for it.
- Key Vault name `kv-bccweb-prod` (13 chars) — within 24-char limit, starts with letter, alphanumeric+hyphens only.

## Task 8 Wave 1 notes — Idempotent UUIDs, resume, dry-run, production guard

### Entity keys used in id-map (key format: "${entity}:${sqlId}")
| entity      | SQL table        | sqlId field     | notes |
|-------------|------------------|-----------------|-------|
| manufacturer| Manufacturers    | r.ID            | stable int PK |
| rating      | PilotRatings     | r.ID            | stable int PK |
| club        | Clubs            | r.ID            | stable int PK |
| site        | Sites            | r.ID            | stable int PK |
| season      | Seasons          | r.ID            | stable int PK |
| pilot       | Pilots           | r.ID            | stable int PK |
| person      | People           | r.PersonID ?? r.ID | PersonID FK; fall back to pilot.ID if null (orphaned record) |
| roundTeam   | RoundTeams       | rt.ID           | stable int PK |
| round       | Rounds           | r.ID            | stable int PK |
| flight      | Flights          | flight.ID       | stable int PK |

### uuidv4() call sites replaced (10 total)
- Lines 159, 173, 185, 208, 246, 305, 348, 447, 463, 511 in original migrate.mjs
- All replaced with `getOrCreateUuid('<entity>', <sqlId>)`
- In-memory Maps (clubUuid, siteUuid, etc.) still populated for cross-reference lookups

### Entities with no UUID generated (not in id-map)
- `config.json` — singleton, no SQL row ID
- `pilot-ratings.json` (index blob) — just the list; each rating has its own UUID via `rating:ID`
- `round-briefs/{roundId}.json` — keyed by round UUID, no separate brief UUID; legacyId=rb.ID persisted in doc
- Pilot slots (RoundTeamPlaces) — embedded in round doc as anonymous objects; no top-level UUID. Future tasks (17/18) may need `pilotSlot` entity if they require stable slot IDs.

### person UUID synthesis
- `r.PersonID` is the stable FK to People table (1:1 with Pilot)
- If `PersonID` is null (orphaned pilot record with no People row), falls back to pilot's own SQL ID
- Key becomes `person:${r.PersonID ?? r.ID}` — safe and deterministic either way

### Production guard placement
- Guard runs as absolute first statement in `main()`, before console.log, before sql.connect()
- Regex `/Server=tcp:.*bcc-prod/i` — case-insensitive, matches any hostname containing "bcc-prod"
- Double lock: requires BOTH `--force-production` CLI flag AND `PRODUCTION_CONFIRM=YES` env var

### DRY_RUN behavior
- Honored via `--dry-run` CLI flag OR `DRY_RUN=1` env var
- In dry-run: no blobs written, but id-map IS still persisted (UUIDs assigned and saved)
- This means repeated dry-runs also produce stable UUIDs

### Resume mode
- `--resume` flag: before each blob upload, downloads existing blob and compares SHA-256 hash
- If hash matches, upload is skipped with `[RESUME] skip <path> (unchanged)`
- BlobNotFound error during resume check is caught and treated as "proceed with upload"

### Log masking extended
- Original: `Password=[^;]+`
- Added: `AccountKey=[^;]+`, `SharedAccessSignature=[^?&"'\s]+`, `Authorization:\s*\S+`
- All case-insensitive via `/gi` flag

### Atomic write pattern
- id-map: write to `.migration-state/id-map.json.tmp` then `renameSync` to final path
- reconcile report: same pattern with `.migration-state/reconciliation-report.json.tmp`
- `renameSync` is atomic on same filesystem — crash-safe

### .migration-state/ retention
- Added to `.gitignore` — operators manage retention manually (per MUST NOT DO)
- Directory created on demand by `ensureLoaded()` and `saveIdMap()`

## Task 1 Wave 1 notes
- Added new exported types in `packages/types/src/index.ts`: `Signature`, `BriefVersion`, `SignToFlyWording`, `SeasonClub`, `Frequency`.
- Extended existing entities without changing their existing field order: `Team` now includes `captainPilotId`; `Round`, `Pilot`, `Club`, and `Site` now carry audit fields; `Season`, `ClubTeam`, and `PilotRating` now include `legacyId` where it was missing.
- Kept `PilotSeasonClub` unchanged and added `SeasonClub` separately as requested.
- Used `string` for UUID/ISO timestamp fields and a discriminated union for `Signature.source`.
- No runtime validation was added.

## Task 5 Wave 1 notes (E2E harness)
- Installed `@playwright/test@^1.60.0` at workspace root via `npm add -D -W @playwright/test`.
- Browser install: `bunx playwright install chromium` — no `--with-deps` needed on macOS (arm64). Downloaded Chrome for Testing 148.0.7778.96 (playwright chromium v1223) to `/Users/matthew/Library/Caches/ms-playwright/chromium-1223` plus FFmpeg and Chrome Headless Shell to the same cache directory.
- No warnings during install; browser binaries are user-cache-scoped (not committed).
- Config convention: `tests/e2e/playwright.config.ts` with `testDir: "."` — all `.spec.ts` files inside `tests/e2e/` are picked up automatically.
- Single project `chromium-desktop` using `devices['Desktop Chrome']`; `baseURL` from `process.env.E2E_BASE_URL ?? "http://localhost:5173"`.
- No `webServer` block — dev stack is operator-launched before running tests (docker compose + func start + vite dev).
- `bun run e2e` script registered at root (`playwright test --config tests/e2e/playwright.config.ts`).
- `--list` verification output: `[chromium-desktop] › smoke.spec.ts:4:5 › smoke: home page contains BCC branding` — config is valid.
- Evidence saved to `.omo/evidence/task-5-e2e-list.txt`.
- `.gitignore` extended with `playwright-report/`, `test-results/`, `tests/e2e/playwright-report/`, `tests/e2e/test-results/`.

## Task 6 notes (IaC storage hardening)
- IaC uses BOTH `azapi` (~> 2.8) AND `azurerm` (~> 3.0) providers — azurerm is used for
  `azurerm_key_vault`, `azurerm_role_assignment`, and `data "azurerm_client_config" "current"`.
  The AGENTS.md note "azapi is the right resource" is not fully accurate; check providers.tf first.
- Management locks via azapi: `azapi_resource` with type `Microsoft.Authorization/locks@2020-05-01`,
  `parent_id = <resource>.id`. This is equivalent to `azurerm_management_lock` but uses the azapi
  provider that is already installed. No need to add a second provider block.
- `terraform plan -backend=false` works without real Azure credentials because the azurerm data
  source (`azurerm_client_config`) is resolved during plan using ambient CLI auth (az login).
  The plan succeeded here because `az login` was previously run in this environment.
- azapi v2 body in plan JSON: when body is an HCL object (not a JSON string), `terraform show -json`
  renders it as a nested JSON object under `values.body`. No `fromjson` needed, but the jq script
  handles both forms defensively: `if type == "string" then fromjson else . end`.
- jq pattern for checking CORS origins across all rules (flatten nested arrays safely):
  `[($bs_props.cors.corsRules // [])[] | (.allowedOrigins // [])[]] | index("*") != null`
- `terraform.tfvars.example` must cover ALL variables with no default in any .tf file, not just
  the ones you touched. Run `terraform plan` once to discover missing vars, then add them.
- The `jwt_secret` variable declaration was removed from `variables.tf` at some point (now handled
  via Key Vault reference in functions.tf) but leaving a stub in tfvars.example causes only a
  WARNING, not an error — safe to leave for operator guidance.
- Change feed (`changeFeed.enabled = true`) lives in the blob service body alongside versioning
  and soft-delete; all four properties coexist in `Microsoft.Storage/storageAccounts/blobServices`.

## Task 10 notes — Lease renewal helper and round long-op extraction
- Added `withLeaseRenewing` / `withPrivateLeaseRenewing` in `apps/api/src/lib/blob.ts`; default lease duration is 30s and default renew cadence is 15s, with a guard rejecting intervals at or above half the lease duration.
- Azurite supports `renewLease()`, `releaseLease()`, and `breakLease(0)` well enough for integration tests; after a force-break, the renewal interval records the failure and the helper surfaces `LeaseRenewalFailedError` after the in-flight callback settles.
- `lockRound` now performs PureTrack group creation, brief JSON/PDF generation/upload, and ACS email sending before acquiring the final round write lease. The lease is only used for status/isLocked, pilot accounted/sign-to-fly reset, PureTrack ID persistence, and brief path/version metadata.
- `completeRound` now computes `scoreRound()` from a pre-read snapshot outside the lease, then reacquires and validates the round is still Locked before persisting the Complete scored snapshot under a renewing lease.

## Task 14 notes (CORS lockdown)
- Final blob CORS rule should be: `allowedMethods = ["GET", "HEAD", "OPTIONS"]`, `allowedHeaders = ["Content-Type", "Authorization", "x-ms-version", "x-ms-date", "x-ms-blob-type", "If-Match", "If-None-Match", "If-Modified-Since", "Range"]`, `exposedHeaders = ["x-ms-request-id", "x-ms-version", "Content-Length", "Content-Type", "ETag", "Last-Modified"]`, `maxAgeInSeconds = 3600`.
- `allowed_origins` must stay default-empty in `variables.tf`; operators supply explicit SPA origins via tfvars to fail closed.
- azapi plan JSON for `body` can be object-shaped; jq checks should flatten `cors.corsRules` defensively before asserting origins/methods/headers.

## Task 15 notes (register enumeration neutralization)
- Chose a 60s verification resend window keyed on the stored verification token `createdAt`: reuse the same token inside the window, regenerate after 60s.
- Reasoning: keeps retries idempotent for double-clicks while limiting resend abuse and preserving the constant 202 response.

## Task 12 notes — structured HTTP errors
- Canonical error code table used:
  - 400 -> BAD_REQUEST / INVALID_BODY / INVALID_JSON / INVALID_DATE / INVALID_YEAR / INVALID_STATUS / INVALID_TOKEN / MISSING_* / INVALID_BODY
  - 401 -> UNAUTHORIZED / INVALID_TOKEN
  - 403 -> FORBIDDEN
  - 404 -> NOT_FOUND
  - 409 -> CONFLICT
  - 429 -> RATE_LIMITED
  - 502 -> PURETRACK_UPSTREAM_ERROR
  - 500 -> INTERNAL / RECOMPUTE_FAILED
- Tricky conversions:
  - `authFunctions.ts` still has nuanced verification/reset flows and silent-success branches; wrapper preserved success responses and standardized only explicit error paths.
  - `roundsMutate.ts`, `teams.ts`, and `flights.ts` had validation-error throw patterns embedded in lease helpers; converted those to `HttpError` so the wrapper can shape all failure payloads consistently.
  - `puretrack.ts` upstream failures now throw `HttpError(502, PURETRACK_UPSTREAM_ERROR, ...)` instead of returning raw upstream text.


## Task 9 notes — Atomic token consume via ETag + lifecycle TTL GC

### Lifecycle resource shape
- Type: `Microsoft.Storage/storageAccounts/managementPolicies@2023-01-01`
- Name: `default` (singleton per storage account)
- parent_id: the storage account resource ID (NOT the blob service)
- prefixMatch format: `"{container}/{blob-prefix}"` — includes the container name
  e.g. `"data-private/auth/tokens/"` targets auth/tokens/ blobs in data-private
- daysAfterModificationGreaterThan applies to last blob modification time
  (consumed-marker upload resets the clock, so consumed tokens GC 7 days after consumption)
- depends_on blob_service and the private container to avoid ordering races

### ETag conditional: delete vs conditional-write
- Task spec said "conditional DELETE via deleteIfExists(ifMatch)" but this creates
  a 404-after-delete problem: after the first consumer deletes the blob, the second
  consumer's download() returns 404 → TokenNotFoundError (indistinguishable from
  "token never issued").
- Fix: conditional UPLOAD of a `consumed: true` marker instead of delete. This way:
  - Second sequential consume reads consumed:true → TokenAlreadyConsumedError (correct)
  - Concurrent: 9 of 10 get HTTP 412 on upload (ETag mismatch) → TokenAlreadyConsumedError
  - Expired token: blob untouched, lifecycle GC handles cleanup as before
  - Missing token: download 404 → TokenNotFoundError (correct)
- The `consumed?: true` field is added to AuthToken interface in authHelpers.ts
- Lifecycle GC still fires: consumed blobs are modified (not deleted), GC timer = 7d after last modification

### Azurite behavior
- No soft-delete by default; deleted blobs are truly gone
- Conditional upload with ifMatch ETag works correctly: 412 on stale ETag
- All 10 concurrent upload calls in the concurrency test got 9x HTTP 412 as expected
- [METRIC] auth.token.reused console.warn logged for each 412

## Task 11 notes — Pilot index lease + atomic recompute tmp-swap
- Pilot index writes now create `pilots.json` if absent, then acquire a public blob lease and perform read-modify-write through `getBlobClient`/`getBlockBlobClient().uploadData(..., { conditions: { leaseId } })`; sorting ties by id avoids nondeterministic order for equal names.
- Recompute uses a separate sentinel lease blob `seasons/{year}.json.lock` containing `{"purpose":"recompute-lock"}` and consumes Task 10 `withLeaseRenewing`; heavy reads/scoring happen before the lease.
- Swap strategy chosen: upload deterministic bytes to `{path}.tmp`, then `beginCopyFromURL(tmp.url)` to final, then delete tmp only after copy success. If final copy fails, tmp remains for forensics.
- `stableStringify()` recursively sorts object keys, drops `undefined`, appends a trailing newline, and relies on explicit domain array sorts before stringify (`rounds` by date/id, league by rank/score/club/team, result teams/pilots by score with stable tie-breakers).
- Same-process concurrent `recomputeSeason(year)` calls share one in-flight promise before hitting Azure, so duplicate fire-and-forget callers wait/no-op and emit one final season swap in tests.
- Azurite quirk: `beginCopyFromURL` works for local same-container copies in tests, but spies need to match encoded blob names in URLs (`seasons%2F...`) when counting/capturing copy attempts.

## Task 13 notes — 401 auto-refresh with single-flight lock

### Mock strategy for fetch in jsdom Vitest tests
- `vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => { ... })` is the correct approach — no heavy deps (no MSW, no fetch-mock).
- Mock callbacks require explicit parameter types when `strict: true` / `noImplicitAny` is on; `async (input)` without annotation causes TS7006. Use `(input: RequestInfo | URL, init?: RequestInit)` signature.
- Distinguish first call vs retry in mock by inspecting `init?.headers["Authorization"]`: first call has old token, retry has new token (read from localStorage after refresh).
- `mockResolvedValue(response)` is fine for tests that only need one fixed response (e.g. ApiError shape test).

### localStorage in jsdom
- `localStorage` is available globally in jsdom env; `localStorage.clear()` in `beforeEach`/`afterEach` is sufficient — no special setup needed.
- `window.dispatchEvent(new CustomEvent("bcc:auth-expired"))` is synchronous in jsdom. A listener registered before the `await api.get(...)` call will have fired by the time the awaited promise rejects, so assertions on the event array are safe immediately after `await expect(...).rejects.toThrow()`.
- Module-level state (`refreshInFlight`) resets to null naturally between tests because `.finally(() => { refreshInFlight = null })` runs as part of promise settlement, which is always complete before the test's `await` resolves/rejects.

### Event-name conventions
- `bcc:refresh-start` — fired by `refreshAccessToken()` at the top of the try block (before the fetch)
- `bcc:refresh-end` — fired in the `finally` block of `refreshAccessToken()`, always fires whether refresh succeeded or failed; runs BEFORE the returned promise settles
- `bcc:auth-expired` — fired in the `catch` block of `refreshAccessToken()` when refresh fails; tokens already cleared from localStorage at point of dispatch
- `AuthProvider` subscribes to all three via `window.addEventListener` in separate `useEffect` hooks; `bcc:auth-expired` triggers `logout()` (clears React state) + `navigate(loginUrl(...))` via `useNavigate`

### Single-flight correctness invariant
- The assignment `refreshInFlight = refreshAccessToken().finally(...)` is synchronous — no `await` sits between the `if (refreshInFlight === null)` check and the assignment. JavaScript's single-threaded event loop guarantees that between any two `await` boundaries, code is atomic, so exactly one concurrent caller wins the race to set `refreshInFlight`.
- `localStorage.setItem(ACCESS_TOKEN_KEY, accessToken)` happens inside `refreshAccessToken()` BEFORE its async function resolves, so all `await refreshInFlight` continuations see the new token when they read `localStorage` on the next line.

### ApiError constructor change — watch for callers
- Old 2-arg constructor `(status, message)` → new 3-arg minimum `(status, code, message)`.
- `RoundBrief.tsx` had an inline `new ApiError(res.status, msg)` for PDF download errors; updated to `new ApiError(res.status, "DOWNLOAD_FAILED", msg)` to restore compile.

## Task 16 notes — Rate-limit + account lockout on /api/auth/*

### Rate-limit limits chosen (capacity = 1-minute budget; refillPerMin = same value)
| endpoint            | capacity | rationale |
|---------------------|----------|-----------|
| login               |       10 | 10 attempts/min is generous for humans, hard for automated spray |
| register            |        3 | sends email; 3/min prevents abuse while allowing quick retries |
| forgot-password     |        3 | sends email; same as register |
| reset-password      |        5 | token already gated; 5/min allows mobile copy-paste retries |
| verify-email        |       10 | GET-link clicks; generous as browsers may retry |
| refresh             |       30 | called on page load / tab focus; must stay permissive |
| resend-verification |        3 | sends email; same as register |

### Lockout window rationale
- Failure window: 10 minutes (same window as NIST 800-63B brute-force window guidance)
- Max failures: 5 (below typical dict-attack burst of 10-20/s; high enough to tolerate fat-finger)
- Lockout duration: 15 minutes (long enough to be disruptive to attacker; short enough for pilot
  who forgot their password to recover without a support ticket)
- Lockout by userId (NOT IP): paragliding meets share NAT gateways — IP lockout would lock
  innocent pilots competing alongside an attacker on the same cell connection.

### HttpError headers extension (Task 12 extension)
- Added optional 4th constructor param `headers?: Record<string, string>` to `HttpError`.
- `withErrorHandler` now spreads `err.headers` into the returned `HttpResponseInit` when present.
- Used by `rateLimit()` to attach `Retry-After: <secs>` to every 429 response.
- No existing tests broken: existing `HttpError(status, code, detail)` calls ignore the new param.

### vitest.config.ts include strategy
- The file `src/lib/__tests__/blob.test.ts` was intentionally omitted from the include list — its
  "60s op" test calls `vi.setConfig({ testTimeout: 70_000 })` inside the test body which does not
  override the 15 s global timeout in Vitest 4. Broadening to a glob would re-introduce that
  pre-existing failure. New lib tests are added explicitly to the `include` array instead.

## Task 23 notes — Brief safety fields and images
- Brief images are stored as private binary blobs at `round-briefs/{roundId}/image-{n}.png`; `RoundBrief.imagePaths` stores only those private paths, and the SPA loads thumbnails through authenticated `/api/rounds/{id}/brief/images/{n}` rather than `VITE_BLOB_BASE_URL`.
- PDF generation uses an inline Handlebars `default` helper for explicit `Not provided` fallback values. Brief image binaries are not embedded in the PDF to avoid new dependencies and extra blob fetches; the PDF prints a `See briefing images: <count>` line when images exist.

## Task 17 notes — Sign-to-Fly wording + brief versioning
- Wording hash algorithm is exactly `crypto.createHash("sha256").update(html, "utf8").digest("hex")`; the seeded legacy v1 hash is `d25039385dcb52fd848abf7633e185e2e77eb1a0421b62a1f01f0db90288bd7b`.
- Brief hash material fields are limited to operational/safety brief content and W3W points: briefing/check-in/land-by times, narrative, wind, direction of flight, expected landing, airspace/hazards, NOTAMs, BENO line, briefer notes, and site parking/briefing/takeoff W3W. Cosmetic briefer identity/phone and site/location names are excluded.
- `scripts/seed-wording.mjs` idempotency: if `sign-to-fly/wording/1.json` exists with the same hash, it skips the version blob and rewrites only the active pointer; if the existing v1 hash differs, it fails rather than mutating legal history.

## Task 22 notes — Privacy scan + telemetry redactor + GDPR anonymize

### Runbook location
- Chose option (b): runbooks written to `docs/runbooks/privacy.md` and `docs/runbooks/gdpr-erasure.md` (tracked in git, not under .omo/ which is gitignored).
- This keeps legal/compliance documents in the repo alongside the code they govern.

### False positive in initial scan: wingClass in results/ blobs
- Initial scan flagged `wingClass` in all `results/{year}.json` blobs (32 violations).
- Root cause: `wingClass` (EN A/B/C/D) is the paraglider safety-rating CLASS used as the wing-factor multiplier in scoring. It is part of the official public `RoundResult` interface and was intentionally included by T21 migration.
- Decision: removed `wingClass` from `PII_FIELDS` in both `scripts/lib/pii.mjs` and `apps/api/src/lib/telemetryRedactor.ts`. Exception documented in `docs/runbooks/privacy.md` (approved: Matt White, 2026-06-09).
- Remaining equipment fields that ARE PII: `wingModel`, `wingColours`, `harnessType`, `harnessColour`, `helmetColour` — these identify specific personal equipment.

### Single source of truth for PII_FIELDS
- `scripts/lib/pii.mjs` is authoritative (used by scanner + GDPR script).
- `apps/api/src/lib/telemetryRedactor.ts` carries a TS-native copy (documented with a sync warning comment). Cross-package .mjs imports from TypeScript would require `allowArbitraryExtensions` and awkward path mapping — duplicate is simpler.

### CI service-container pattern (Azurite in GitHub Actions)
```yaml
services:
  azurite:
    image: mcr.microsoft.com/azure-storage/azurite
    ports:
      - 10000:10000
    options: >-
      --health-cmd "nc -z localhost 10000"
      --health-interval 5s
      --health-timeout 5s
      --health-retries 15
```
- `nc -z localhost 10000` is the correct health check (netcat TCP probe).
- Seed step uses an inline `node -` script with `import` statements; works because GitHub Actions ubuntu-latest ships Node 20+.
- `BLOB_CONNECTION_STRING` is set as a job-level env var using the Azurite well-known dev string.

### GDPR script double-lock pattern
- Matches T8 production guard: requires BOTH `--confirm` CLI flag AND `GDPR_ANONYMIZE_CONFIRM=YES` env var.
- Script logs field NAMES not VALUES in audit log (privacy-safe audit trail).
- Auth tokens at `auth/tokens/{hash}.json` are enumerated and deleted best-effort (listing may fail gracefully).

### PiiRedactingTelemetryProcessor binding
- `this.process = this.process.bind(this)` in constructor allows the App Insights SDK to call `.addTelemetryProcessor(processor.process)` without losing `this` context.

### Privacy scanner exit code capture with tee
- `node script.mjs 2>&1 | tee file` captures exit code of `tee` not `node`; use sequential form instead: `node ... > file 2>&1; echo "exit: $?" >> file`.

### wingClass in PilotSnapshot (rounds/{id}.json — private)
- `PilotSnapshot` embeds `wingClass` in the private round blob at lock time. This is acceptable: it's private, it's the scoring class, and it's the historical record of what the pilot flew.
- The public-facing equivalent in `RoundResult` is also `wingClass` — same decision applies (scoring category, not PII).

## Task 18 notes — Immutable Sign-to-Fly signature ledger
- Idempotency mechanism: the POST endpoint reads `readSignature(roundId, teamId, place, briefVersion)` first and returns the existing record with 200 for same-version re-signs. `writeSignature()` still uses `ifNoneMatch: "*"` as the storage-level overwrite guard and treats already-exists as a no-op, but endpoint idempotency does not rely on that exception path.
- Legacy coordinator toggle decision: removed the old `PUT /api/rounds/{id}/teams/{teamId}/pilots/{place}/sign-to-fly` registration and handler from `teams.ts` rather than returning 410, because direct coordinator mutation is a legal hazard.
- Task 19/20 caller note: existing SPA callers of `/sign-to-fly` will break intentionally until the pilot self-sign UI and audited coordinator override endpoint are wired.
- Legacy migration writes `source: "legacy-migrated"` signatures to `signatures/{roundId}/{teamId}-{place}-vlegacy.json` with `signedAt`, `ip`, `userAgent`, `briefVersion`, `briefHash`, `wordingVersion`, and `wordingHash` all literal null; Signature.id uses `getOrCreateUuid("signature", "<roundId>-<teamId>-<place>")`.

## Task 20 notes — Coordinator override with audited reason
- Audit log mechanism: used Azure Append Blob via `getAppendBlobClient()`, `create(ifNoneMatch: "*")`, then `appendBlock()` to `data-private/audit/sign-override-YYYY-MM-DD.jsonl`; no leased block-blob fallback needed.
- Extracted T18 signature construction into `buildSignaturePayload()` in `apps/api/src/lib/signTofly/ledger.ts` and moved `extractIp()` there so pilot-self and coordinator override share brief hash, wording hash, IP, and user-agent logic.
- Override signatures always write to `signatures/{roundId}/{teamId}-{place}-v{briefVersion}-override-{randomShort}.json`, so coordinator overrides never overwrite pilot-self records or each other. Audit lines include `originalSignaturePathIfAny` and `pilotAndCoordSigned` when a canonical pilot-self signature already existed.

## Task 25 notes — TsCs gate on registration
- Shared legal version constant mirrored in both apps/api/src/lib/termsConstants.ts and apps/web/src/lib/terms.ts; bump both together whenever the displayed text changes.
- Terms text source for the web page was the legacy file at /Volumes/code/BCCWEB/BCCWeb/Views/Home/Terms_Conditions.cshtml.
- Register now carries acceptTsCs + acceptedTsCsVersion, and /api/me exposes tsCsAcceptanceRequired for later re-acceptance gating.

### Task 19 - Sign to Fly Pilot UI
- Sanitization Config: Used `DOMPurify.sanitize` with `ALLOWED_TAGS: ["p", "strong", "em", "ul", "ol", "li", "br", "h2", "h3", "span"]` and `ALLOWED_ATTR: []` to safely render the HTML wording provided by the Admin.
- Router Quirks: Re-used the existing `RequireAuth` wrapper inside the React Router `<Routes>` component to ensure the pilot sign page is completely protected.
- Deprecated Calls Handled: Found callers of the deprecated `PUT /sign-to-fly` endpoint in `apps/web/src/pages/rounds/RoundManage.tsx` (`toggleField("sign-to-fly", slot.signToFly)`). Did NOT remove this as modifying `RoundManage.tsx` was explicitly forbidden by constraints (reserved for Task 20). Task 20 needs to replace these toggles with the new override modal flow.

## Task 26 notes — Pilot self-serve round registration
- Double-booking algorithm: `POST /rounds/{id}/register-self` reads public `rounds.json`, filters to same `seasonYear`, non-`Cancelled`, and ISO local dates within ±1 day of the target round date before reading candidate private round blobs and checking filled pilot slots. Local-date comparison currently slices `yyyy-MM-dd` and uses UTC day numbers; this avoids browser/server timezone drift for date-only strings but does not model venue-specific timezone/DST if future data stores full datetimes.
- Auto-allocate decision: if the pilot has no `seasonClubs` association for the round's season, the endpoint allocates them to the round organising club and updates `currentClub`; if they already have a different season club, reassignment only happens when private `config.json` includes `autoAllocatePilotsToRoundClub: true`, otherwise it returns `409 NOT_IN_CLUB_FOR_SEASON`.
- RoundDetail coordination with T19: kept T19's per-slot Sign-to-Fly CTA intact and added a separate registration action panel above round info. Unregister is only shown for Proposed/Confirmed unsigned slots; signed slots show the coordinator-contact note instead.

### Task 29: First-login-of-season profile update flow
- Added `firstLoginOfSeason` and `activeSeasonYear` to `/api/me`.
- Added `profileUpdatedAt` to Pilot type.
- Updated `PUT /api/pilots/{id}` to automatically stamp `profileUpdatedAt`.
- Created `<FirstLoginOfSeasonGate>` that intercepts all router navigations (except whitelisted routes) if `firstLoginOfSeason` is true. Used an overlay CSS-based navigation blocker.
- Found out that T25 and T26 had concurrent changes in `me.ts` and `roundRegistration.ts` which required minor patch coordination. Preserved `tsCsAcceptanceRequired` from T25 in `me.ts`.
