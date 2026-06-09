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

## Task 34 notes — Manufacturer URL + PureTrack skip handling
- URL rendering: use `new URL(...)` and allow only `http:` / `https:` before rendering an external anchor with `target="_blank" rel="noopener noreferrer"`.
- Migration normalization: trim `WebsiteUrl`; blank/whitespace values become `undefined`.
- PureTrack skip semantics: keep `pureTrackId === 0` as a stored legacy value, but skip it during group creation with `[METRIC] puretrack.skip pilot lacks pureTrackId` instead of throwing.

## Task 27 notes — Team captain auto-assign + manual reassign

### Factor-out approach chosen
- Created `apps/api/src/lib/teamCaptain.ts` with a single pure exported function
  `recomputeTeamCaptain(team: Team): Team`. Returns a new object (spread), no side effects.
- Called from both `addPilot` and `removePilot` mutation closures inside `teams.ts`.
- This is the T26 integration point: T26's register-self handler can import and call
  `recomputeTeamCaptain` from the same module without duplicating the logic.
- The function is NOT called from `addTeam` or `removeTeam` (no pilots involved).

### Captain auto-assign rules (enforced in recomputeTeamCaptain)
- Place 1 filled AND captainPilotId == null → set captainPilotId = place1.pilotId
- Place 1 filled AND captainPilotId != null → no change (operator override preserved)
- Place 1 empty → captainPilotId = nextLowestFilledSlot.pilotId ?? null (always reassigns)
- Corollary: removing a non-place-1 slot while place 1 is still filled → no change
  because the function finds place 1 occupied with a non-null captain and short-circuits.

### Endpoint pattern (teamsCaptain.ts)
- Separate file keeps teams.ts clean; registered in index.ts under "Phase 6".
- `withPrivateLease` used directly (no mutateLocked abstraction) so the return value from
  the lease callback is cleanly typed — avoids the `Round | HttpResponseInit` union that
  mutateLocked uses.
- Validation order: auth → coord-scope → team existence → pilot-in-team.

### RoundManage.tsx integration (T20 overlap)
- T20 added the Override Sign modal inside `PilotRow` — no structural overlap with
  the captain UI which lives in `TeamCard`'s header section.
- Added `ChangeCaptainSelect` component before `TeamCard` in source order; added
  `canManageCaptain: boolean` prop to `TeamCard` matching `canOverrideSign` pattern.
- `canManageCaptain` mirrors the API's auth rule: Admin OR (RoundsCoord AND clubId matches
  round.organisingClub.id). If round has no organisingClub, coord cannot manage captain —
  consistent with endpoint behavior.
- When `canManageCaptain` is false (e.g. read-only coord viewing another club's round),
  a read-only "Captain: {name}" line is shown instead of the dropdown.

### RoundBrief.tsx — approximate captain display
- `BriefTeamEntry` (packages/types) has no `captainPilotId` field (MUST NOT touch packages/).
- Brief shows captain inferred from place-1 pilot (`placeInTeam === 1`). This is the default
  auto-assigned captain and correct in the common case. Manual overrides won't be reflected
  in the brief view — acceptable approximation documented here for future reference.
  (If T26+ needs accurate captain in the brief, `captainPilotId` should be added to
  `BriefTeamEntry` and brief generation updated in brief.ts.)

### Test patterns
- `teamCaptain.test.ts` — pure unit tests, no Azurite needed, isolated from build deps.
  Added to vitest.config.ts `include` array (not covered by the glob patterns in use).
- `teamsCaptain.test.ts` — integration tests using existing seed helpers (makeUser,
  makeRound, makePilot, readPrivateJson). Pattern matches existing signatures.test.ts.
- Teams.ts `addPilot`/`removePilot` now use `findIndex` + array slot replacement rather
  than mutating the found team reference directly, which is necessary since
  `recomputeTeamCaptain` returns a new object.

## Task 31 notes — SeasonClub + Frequency restoration
- Public `season-clubs/{year}/index.json` shape is `SeasonClubIndexEntry[]`: `{ id, seasonYear, clubId, clubName, numTeams, frequencyId?, frequencyLabel?, acceptedTsCs, acceptedTsCsAt? }`. It intentionally omits `acceptedTsCsBy` to keep person names/user IDs out of the public index.
- Private SeasonClub documents remain at `season-clubs/{year}/{clubId}.json` and carry the full `SeasonClub`, including annual T&C acceptance metadata and optional embedded `Frequency`.
- Serialized registration/update/delete uses private sentinel lease `season-clubs/{year}/index.json.lock`, then writes the private SeasonClub, generated `club-teams/{year}/{clubId}/team-N.json` blobs, `club-teams.json`, and the public SeasonClub index.
- Auto-team naming follows legacy `{ClubName} A`, `{ClubName} B`, ...; stable ids use the same deterministic key shape as migration: `season-club:${year}-${clubId}` and `club-team:${year}-${clubId}-team-${n}`.
- Migration ordering: SeasonClub/Frequency ingestion now runs after Clubs and before Sites/Seasons/Pilots/Rounds, because it needs migrated club UUIDs and can query legacy `Seasons` directly for year lookup.
- Legacy assumptions: Frequency table labels may be stored under `Label`, `Name`, `Description`, `Frequency`, or `Title`; SeasonClub numTeams may be `NumTeams`, `NumberOfTeams`, or `NoTeams`; legacy T&C acceptance is assumed true with date from an available accepted/created timestamp else null; `acceptedTsCsBy` is null.

### Task 30: Brief edit UI & versioning
- We stored `versionHistory[]` directly on the brief JSON blob itself, rather than in a sibling `.jsonl` file. This means a single GET of the brief fetches the audit trace, which is simple and sufficient given the low edit velocity (few versions per round).
- Image uploads use `multipart/form-data`. The `fetch` API doesn't need (and in fact breaks if you explicitly set) `Content-Type: application/json` because `FormData` relies on the browser to set the boundary. Bypassing the `api.post` wrapper was necessary here to avoid hardcoded JSON headers. 

## Task 32 notes — RoundClubPilot resolution decision

### Decision: Option (b) — redundant / discard with audit trail

RoundClubPilot is the legacy pre-team-assignment registration queue. Pilots register under a
club for a round via this path before a coordinator assigns them to a team slot. Post-promotion,
the RoundClubPilot record is superseded by RoundTeamPilot (already captured in Step 8).
Surplus (never-promoted) pilots had no flights and did not affect scoring.

### Rationale summary
- Mutually exclusive with RoundTeamPilot path (controller redirects away when team slot available)
- No FK to RoundTeam/RoundTeamPlace — completely outside the team structure
- All pilot safety data (emergency contacts, medical, equipment) already in pilots/{uuid}.json (Step 7)
- New app model is team-centric; no "non-team participant" concept in Round type
- Adding Option (a) would need new types, new API endpoint, new UI, new PII scanner rules — disproportionate
- Task default: Option (b)

### Implementation pattern: discarded-counts.mjs
- New helper module `scripts/migrate/discarded-counts.mjs` with `writeDiscardedCounts(counts, stateDir?)` and `readDiscardedCounts(stateDir?)`.
- `stateDir` parameter defaults to `.migration-state` but can be overridden in tests — avoids touching real state dir during unit tests.
- Atomic write via tmp-rename (matches id-map.mjs pattern).
- `reconcile.mjs` reads discarded-counts.json and includes `report.discarded` field with entity → count.
- Console output: "Discarded (counted but not migrated): roundClubPilot: N rows"

### Actual row count
Not available at development time (no live SQL access). Will be emitted by `migrate.mjs`
Step 9b on production run and captured in `.migration-state/discarded-counts.json` and
the reconciliation report `discarded.roundClubPilot` field.
Evidence placeholder: `.omo/evidence/task-32-roundclubpilot-count.txt`

### Test location
`apps/api/src/__tests__/migrate-roundclubpilot.test.ts` — picked up by existing glob
`"src/__tests__/**/*.test.ts"` in `apps/api/vitest.config.ts`. No config change needed.
Tests are pure fs contract tests (no SQL, no Azurite) — verify state file shape and
reconcile field population.

## Task 33 notes — PilotClub history preservation

### Blob path layout
- Private blob: `pilots/{pilotUuid}/club-history.json`
- Content: `PilotClubMembership[]` — one entry per legacy PilotClub row, or one
  synthetic "current" entry for active pilots with no legacy rows.
- Container: `data-private` (never written to public `data` container)
- API path: `GET /api/pilots/{id}/club-history`
- Auth: Admin reads any; Pilot reads only their own (403 for other pilots, RoundsCoord).

### Legacy joinedAt/leftAt handling
- SQL columns `JoinedAt`/`LeftAt` may be null in the legacy database — not all pilot
  club transitions were timestamped at entry time.
- Rule: if the SQL value is null, store `null` in the blob — NEVER fabricate a date.
- A null `joinedAt` or `leftAt` is semantically different from "unknown": it means the
  event date was genuinely not recorded and is displayed as "—" in the UI.
- `source:"legacy"` entries come from the SQL PilotClub table.
- `source:"current"` entries are synthesised for pilots who have a `currentSeasonClub`
  but no legacy PilotClub rows; both timestamps are explicitly null.

### Pure logic extraction pattern
- `scripts/migrate/pilot-club-history-logic.mjs` contains `buildPilotClubHistory()` with
  no external imports (no `mssql`, no `@azure/storage-blob`). This allows the function to
  be imported from TypeScript API tests without pulling in the SQL client.
- Declaration file: `scripts/migrate/pilot-club-history-logic.d.mts` (NodeNext `.mts`
  extension required for correct declaration resolution alongside a `.mjs` source).
- `migrate.mjs` imports from this module via a regular ES import and uses it in step 7b.

### Web component pattern
- `PilotProfile.tsx` fetches club history inside the existing pilot `useEffect` (same
  cancellation token, same deps `[id, refresh]`) — avoids a second round-trip and keeps
  timing predictable.
- History section renders unconditionally once the pilot loads (auth is enforced by the
  API: unauthenticated calls to `/club-history` return 403, so the section gracefully
  shows an empty state rather than crashing).
- `source` badge uses subtle colour-coding: grey for "legacy", green for "current".

### Task 28: Pilot Season Clubs (Assign)
- **Reassign Mechanism**: POST `/api/admin/pilot-season-clubs?reassign=true` is used for explicit reassignment to cleanly handle DELETE+POST without needing two clicks.
- **Denorm Map**: Private blob `seasons/{year}/pilot-club-map.json` maintains `{ [pilotId]: clubId }` lookup for rapid O(1) matching during scoring instead of full `pilots/*.json` scan.

## Task 39 notes — PureTrackGroup first-class entity + admin inspection endpoint

### PureTrack API response shape (group creation)
- POST /api/groups returns: `{ id: number, name: string, slug: string }`
- `id` is an integer external group ID on PureTrack's system
- `slug` is the URL-friendly identifier used in the group URL: `https://puretrack.io/group/{slug}`
- Credentials (API key, email, password, session tokens) are never stored in the group blob

### Blob path layout
- Private container (`data-private`): `puretrack-groups/{uuid}.json`
- One blob per group created: 1 round-level group + N team-level groups
- Round group blob: `teamId` field absent; `pilotIds` = all BCC pilot UUIDs with valid pureTrackId
- Team group blob: `teamId` field present; `pilotIds` = BCC pilot UUIDs in that team with valid pureTrackId
- `externalId` = `String(ptApiGroup.id)` (number → string)
- `externalUrl` = `https://puretrack.io/group/{slug}`
- Blob is written right after the `createGroup` API call succeeds, before `importPilots`
- If `createGroup` fails, blob is never written (error propagates, no orphan records)

### Listing / filter strategy
- Admin inspection endpoint `GET /api/admin/puretrack/groups?roundId={id}` lists all blobs under
  `puretrack-groups/` prefix via `ContainerClient.listBlobsFlat({ prefix: "puretrack-groups/" })`
  and filters in-memory by `data.roundId === roundId`
- This is a full scan of the prefix; acceptable at current scale (1–2 groups per round × few rounds)
- If scaling concern arises later, add a `puretrack-groups-index/{roundId}.json` index blob
- RoundsCoord scope check: load the round blob, compare `round.organisingClub.id` with `caller.clubId`

### TypeScript / Vitest notes
- `vi.fn<TFn>()` signature in Vitest 4: single generic parameter is the full function type,
  e.g. `vi.fn<(path: string, data: unknown, leaseId?: string) => Promise<void>>()`
  NOT the two-tuple form `vi.fn<[Args], Return>()` which is rejected by strict TS
- `vi.hoisted()` is required when a spy variable used inside `vi.mock()` factory needs to be
  accessible both inside the factory and in test assertions
- `blob.ts` was NOT modified (per MUST NOT DO); listing uses a local `getPrivateContainerClient()`
  in `functions/puretrack.ts` that duplicates the small connection pattern from `blob.ts`

### Local interface rename
- `puretrack.ts` lib had a local `interface PureTrackGroup { id: number; name: string; slug: string }`
  for the PureTrack API response. Renamed to `PureTrackApiGroup` to avoid conflict with the new
  `PureTrackGroup` entity exported from `@bccweb/types`

## Task 45 notes — Sign-to-Fly E2E journey
- Mock mechanism chosen for the committed spec: Playwright route interception for `/api/*` and `/blob/*`, so the journey can run without real ACS or PureTrack credentials and without modifying production API/web code. Registration/verification is mocked as an ACS email interception equivalent by returning the verification success path for `/api/auth/verify`.
- Dev-stack helper pattern: `tests/e2e/_setup/dev-stack.ts` starts `docker compose up -d azurite azurite-init`, then API via `bun --filter @bccweb/api run start` with `MOCK_ACS=1` and `MOCK_PURETRACK=1`, then web via `bun --filter @bccweb/web run dev`; it waits for `/api/health` and the Vite base URL before returning a cleanup handle.
- Wait strategy: prefer role/text locators with `await expect(...).toBeVisible({ timeout: 5000 })`; use direct API/blob assertions only for invisible ledger invariants such as invalidated `slot.signToFly`, preserved signatures, `source=coord-override`, and league recompute.

## Task 50 notes — Production dry-run orchestrator

## Task 48 notes — Post-deploy smoke gate

## Task 52 notes — azurerm provider bump
- `terraform init -upgrade -backend=false` could not resolve any `~> 5.0` release in this environment; the latest available stable major was `hashicorp/azurerm ~> 4.0`, which resolved to `v4.76.0`.
- v4 flagged `enable_rbac_authorization` as deprecated on `azurerm_key_vault`; switched to `rbac_authorization_enabled = true` and kept the existing Key Vault/role-assignment wiring unchanged.
- `azurerm_application_insights`, `azurerm_monitor_action_group`, `azurerm_monitor_metric_alert`, and `azurerm_monitor_scheduled_query_rules_alert_v2` all planned cleanly on v4 with no schema edits needed.
- Poll interval chosen: 5s with a 120s ceiling (24 attempts) to balance fast feedback with transient Azure startup delays.
- GitHub Actions variables (`vars.API_HOST`, `vars.WEB_HOST`) were chosen over secrets because these are environment routing values, not credentials.
- Branch protection for the smoke check must be configured manually in GitHub repo settings; Terraform cannot enforce the required status check here.
- BACPAC restore approach: `dry-run-against-prod.sh` treats `BACPAC_PATH` as optional. If provided and `sqlpackage` is installed, it requires `BACPAC_TARGET_CONN` and imports the BACPAC there, then runs the dry-run against that restored database. If `sqlpackage` is unavailable, the script fails with an explicit manual-restore instruction rather than silently continuing against the wrong SQL source.
- Env-var guard rationale: `PROD_DRY_RUN_CONFIRM=YES` is required before any SQL or blob client is created, matching the Task 8 double-lock style. The dry-run still passes `PRODUCTION_CONFIRM=YES` to `migrate.mjs` because `--force-production` is intentionally retained for production-source validation, but `BLOB_CONNECTION_STRING` is always set from `STAGING_BLOB_CONN` so the orchestrator never writes to production blobs.
- Reconciliation fallback: when `PROD_BLOB_CONN` and `az` are available, the script records a production public-blob path/count snapshot. Without `az`, it falls back to expected counts parsed from `.migration-state/prod-dryrun-stdout.txt`, keeping canned-fixture and offline validation deterministic.
- Flakiness observed: no browser run was possible unless a web dev server is reachable on `E2E_BASE_URL`/5173; the spec still lists cleanly with Playwright config and captures screenshots when executed against a running web server.

## Task 44 notes — Scoring regression fixtures
- Real historical legacy round exports were not available in this workspace, so Task 44 fixtures are explicitly named `synthetic-handcrafted-*` and each JSON file carries a `notes` field stating the formula used for expected values.
- Fixtures preserve only competition data needed by `scoreRound()` / `computeLeague()`: wing class, distance, `isScoring`, `noScore`, place ranking, scoring type, and first-XC/PB-style flags. Pilot ids are synthetic UUID-shaped values; no real names, email, phone, medical, emergency-contact, BHPA, IP, or user-agent data is present.
- Rounding gotcha: individual pilot scores are rounded to 1 decimal before team aggregation (`round1(distance * wingFactor)`), then team totals are rounded to 1 decimal again after summing the top `maxScoringPilotsInTeam` scoring slots. Regression assertions use `< 0.05` for pilots and `< 0.1` for teams/league scores; league rank remains exact.
- `computeLeague()` returns entries keyed by `clubId|teamName`, not `team.id`; regression tests map back to fixture team ids via the scored round's club/teamName pair before asserting expected league positions.

## Task 42 notes — Round lifecycle integration suite
- Lifecycle tests use real Azurite blobs and registered Function handlers (`createRound`, `confirmRound`, `briefCompleteRound`, `signOwnSlot`, `lockRound`, `completeRound`, `updateRoundBrief`, `overrideSlotSignature`) rather than spawning an HTTP server. Each scenario seeds unique UUIDs and an isolated high-number season year to avoid cross-test contamination in shared public indexes.
- PureTrack is mocked at `../../lib/puretrack.js` with a controllable `createPureTrackGroups` vi.fn. The failure-path strategy is to reject that mock before `lockRound`; because T39 group blob writes live inside the real PureTrack implementation, this proves lock continues without creating any `puretrack-groups/` blob in the integration path.
- ACS/PDF are mocked in the lifecycle file rather than relying only on global setup because lock imports `briefHtmlBody` and `briefPlainText` as well as `sendEmail`/`getBriefRecipients`; the suite exposes all four exports and toggles recipients per test.
- Recompute crash strategy: spy on `BlobClient.prototype.beginCopyFromURL` and throw only for the first `seasons/{year}.json` final copy. This leaves the `.tmp` uploaded by `swapJsonBlob`, keeps the prior final season blob intact, and lets a rerun with restored spy succeed.
- T10 lease quirk: `withLeaseRenewingOnClient` rejects the default 15s renewal interval for Azurite's 30s lease because the guard uses `leaseDurationSec * 500`; tests partially mock `withLeaseRenewing`/`withPrivateLeaseRenewing` to keep production behavior but pass `renewIntervalMs: 1000` unless the caller overrides it.
- `completeRound` scoring requires private `config.json`; seed helpers write a minimal all-ones `wingFactors` config so `scoreRound()` can score locked-round snapshots deterministically.

## Task 41 notes — Auth flow integration suite

### Email mock extension pattern
- Existing `vi.mock("../../lib/email.js", ...)` in `apps/api/src/__tests__/helpers/setup.ts` returns
  `sendEmail: vi.fn().mockResolvedValue(undefined)` — calls were already recorded by Vitest's
  internal `mock.calls` array, just never surfaced as a named helper.
- Additive change: after the vi.mock factory, added a static `import { sendEmail } from "../../lib/email.js"`
  and exported `getSentEmails()` (reads `vi.mocked(sendEmail).mock.calls`) and `clearSentEmails()`
  (delegates to `mockClear()`). vi.mock is hoisted ABOVE static imports by Vitest, so import order
  doesn't matter for correctness — but added a brief comment to deter future "fix the import order"
  refactors that would break the mock binding.
- Did NOT touch the existing `vi.mock(...)` body. All prior tests using `vi.mocked(sendEmail).mockClear()`
  keep working identically.

### Fake-timer pattern for lockout scenario
- `vi.useFakeTimers({ toFake: ["Date"] })` faked only Date — leaves `setTimeout` real. This was
  critical because `register` runs `await ensureMinimumDuration(startedAtMs, 100)` which calls
  `await sleep(ms)` (setTimeout). Faking all timers would deadlock the sleep; faking only Date lets
  the 100ms constant-time pad run as a real wait while clock arithmetic stays controllable.
- For lockout time-travel (5 wrong → 423 → advance 16min → correct succeeds): set `baseTime`,
  exhaust failures, assert 423, then `vi.setSystemTime(base + 16*60_000)` and `resetAllBuckets()`
  before the final attempt. Buckets are in-memory and key off `Date.now()` for refill — faking Date
  fools the refill math, so explicit reset is required to clear the per-IP bucket state.
- `vi.useRealTimers()` in `afterEach` to avoid polluting subsequent tests in the same file.

### Test isolation patterns that mattered
- Used a per-test unique IP via a `uniqueIp()` helper (`198.51.<a>.<b>`) for `x-forwarded-for` so
  the in-memory TokenBucket registry never shares state between tests OR with the sibling
  `authRegister.test.ts`/`registerTsCs.test.ts` (which run in the same file ordering).
- Combined with `resetAllBuckets()` in `beforeEach`. Belt-and-braces; either alone is enough.
- Used `randomUUID()` in all generated emails to keep `user-index.json` writes append-only and
  never collide.

### Token blob seeding for negative paths
- Verify expired: write `auth/tokens/{sha256(token)}.json` directly with `expiresAt` in the past.
  Handler download() returns the doc with `expiresAt < now()` → `TokenExpiredError` → 400 INVALID_TOKEN.
  Asserted the blob is NOT mutated (no `consumed: true` written) since lifecycle TTL handles GC.
- Stale verification state for >60s resend: write `auth/verification-state/{userId}.json` with
  `createdAt = Date.now() - 70_000`. Register's `loadVerificationState` sees `now - createdAt > 60s`
  → reissue branch. Asserted the resulting state file's `token` differs from the seeded stale value.
- Reset double-consume parallel: `Promise.all` of two reset-password calls with the SAME token.
  T9 atomic ETag flow guarantees exactly one wins (200) and the other gets 412 → TokenAlreadyConsumedError
  → 400 INVALID_TOKEN. Asserted sorted statuses === [200, 400] and the 400 carries code INVALID_TOKEN.

### auth.token.reused metric not emitted on login
- Confirmed by spying console.warn and asserting NO call argument string-includes "auth.token.reused"
  during a wrong-password login. Login flow does not touch short-lived tokens, so the metric must
  never fire — verifies the two counters are correctly distinct.

### Test scoreboard
- 14 scenarios, all green on first run. 3.93s wall-clock. Build clean.
- T42's pre-existing failures in `roundLifecycle.integration.test.ts` are unrelated (reproduced
  with my setup.ts edit reverted via `git stash push -- apps/api/src/__tests__/helpers/setup.ts`).

## Task 43 notes — Migration smoke test against canned fixture

### Fixture format chosen
- Plain `.sql` files (NOT a BACPAC) at `scripts/migrate/fixtures/canned/`:
  - `schema.sql` — CREATE TABLE for every legacy table the migration queries
    (Statuses, Manufacturers, PilotRatings, Clubs, Sites, Seasons, Frequencies,
    SeasonClubs, SeasonClubFrequency, People, AspNetUsers, Pilots,
    PilotSeasonClubs, PilotClub, Teams, Rounds, RoundTeams, RoundTeamPilots,
    RoundTeamPlaces, Flights, RoundBriefs, RoundClubPilots).
  - `seed.sql` — 2–3 rows per entity, fully synthetic (`Synthetic Alpha`,
    `alpha@example.test`, `+44-1632-960xxx` UK-reserved phone block). One
    Complete round + one Confirmed round (no teams) so the fixture exercises
    both the scoring/league path and the "no flights" path.
  - README documents the rationale (BACPAC requires SqlPackage which is not
    consistently available on arm64; .sql files diff cleanly in PR review).

### testcontainers vs Docker-cli approach
- Chose **direct `docker` CLI via `child_process`** — no new npm dependency.
  testcontainers would have added `@testcontainers/mssqlserver` + transitive
  deps for one ephemeral container in one test file.
- Image: `mcr.microsoft.com/azure-sql-edge:latest` (arm64-compatible — the
  official `mcr.microsoft.com/mssql/server` image is amd64-only and refuses
  to start on Apple Silicon). Azure SQL Edge speaks TDS, so `mssql` connects
  unmodified. Cold start ~30–45s on M-series; test polls connection with a
  120s deadline.
- Container started with `-p 0:1433` to avoid host port collisions; resolved
  to the **container network IP** via `docker inspect` because the published
  host-port mapping is unreliable under Apple's `container` runtime (the
  socktainer shim's port forwarding can drop TDS connections immediately
  after handshake — observed `ECONNRESET` on every connect via 127.0.0.1).

### Local Docker daemon on this dev box
- This Mac uses Apple's `container` CLI + `socktainer` (docker-compat shim)
  instead of Docker Desktop. Required two manual steps once:
  `container system start` then `nohup socktainer --no-check-compatibility &`
  (the bundled socktainer was built against container 0.12.0; runtime here is
  0.12.3 — the compat-check refuses to start without the flag). This only
  affects local dev — CI runners ship a normal Docker daemon.

### Isolation strategy
- Per-run unique Azurite container names (`smoke-public-<8hex>` /
  `smoke-private-<8hex>`) so the test never touches dev `data`/`data-private`.
  Containers are created in `before` and best-effort deleted in `after`.
- Migration + reconcile run with `cwd = mkdtempSync(...)` so id-map.json
  and reconciliation-report.json live in a per-run tmpdir, never polluting
  the repo's `.migration-state/`.

### Tricky migration ordering observed
- `season-clubs/{year}/{clubId}.json` are **private** (detail); only the
  yearly `season-clubs/{year}/index.json` is **public**. I initially asserted
  6 private `season-clubs/` blobs expecting both detail + index; correct is 3.
- `pilots/` prefix in the private container counts BOTH `pilots/{uuid}.json`
  (pilot detail, T21-stripped) AND `pilots/{uuid}/club-history.json` (T33).
  The smoke test partitions them with two regexes to count each independently.
- Legacy-migrated signatures (T18) are written **only** for places with
  `SignToFly=1` AND a non-null pilot — fixture seeds 3 places filled but only
  2 with SignToFly=1, so expect 2 `signatures/` blobs (not 3).
- Apple `container` runtime + socktainer published-port mapping is broken
  for TDS; always resolve to container IP from `docker inspect` for any
  test that needs TCP into a SQL Server container.

## Task 49 notes — Cutover runbook
- Created docs/runbooks/cutover.md with 12 substantive sections covering the end-to-end migration lifecycle.
- Rollback window confirmed as 7 days per Decision #7.
- Sign-off matrix includes 11 specific blockers with evidence paths cross-referenced for Tasks 1-45.
- Prerequisites identified:
  - T51 (ACS DNS verification) must complete before DNS cutover phase.
  - T46+T47 (App Insights/Alerts) must complete before "Application Insights + alert rules" sign-off.
  - T48 (CI smoke gate) must complete before "Post-deploy smoke gate in CI" sign-off.
  - T50 (Production dry-run) must complete before final sign-off.
- Rollback plan uses concrete az storage blob copy start commands leveraging the versioning feature from T6.
- DNS verification requires dig check of CNAME propagation.
- Maintenance window communication templates provided.

## Task 46 notes — Application Insights wiring + PII-redacting telemetry processor

### Connection-string seed mechanism (mirrors T7 jwt-secret pattern)
- The AI connection string is exposed as a **sensitive** Terraform output
  (`application_insights_connection_string`). It still lives in state (the
  resource owns it), but `sensitive = true` keeps it out of plan/apply diff
  output and CI logs.
- `scripts/iac/seed-secrets.sh` is the bridge: it reads the sensitive output
  via `terraform output -raw` and writes the value to Key Vault as
  `appinsights-connection-string`. No `azurerm_key_vault_secret` resource is
  ever created, so the plaintext value is never written into state by a
  separate secret resource (the only place it appears is on
  `azurerm_application_insights.main.connection_string`, which is unavoidable
  — every consumer needs it to ingest).
- The Function App reads it at runtime via the standard
  `@Microsoft.KeyVault(VaultName=...;SecretName=appinsights-connection-string)`
  reference syntax in app_settings, resolved through its system-assigned
  managed identity (same identity that already reads `jwt-secret`).

### Sampling decision
- Two layers configured:
  1. **Server-side (AI resource)**: `sampling_percentage = 25` in
     `iac/insights.tf`. This caps ingestion cost at the Azure side and
     applies to ALL telemetry, including auto-collected requests.
  2. **SDK fallback (Function App)**: `APPINSIGHTS_SAMPLING_PERCENTAGE=25`
     env var, used by manual `track*` calls before they reach the ingest
     endpoint.
- Exceptions / failed requests: the v2 SDK's default `addTelemetryProcessor`
  pipeline runs BEFORE sampling, so the redactor scrubs every envelope
  regardless of sample fate. Real-incident triage data preservation will be
  handled in T47 by setting an `excludedTypes = ExceptionData` adaptive
  sampling override on the AI resource — kept out of T46 to keep blast
  radius small.

### applicationinsights SDK version quirk — pinned to v2, NOT v3
- The task spec uses v2 APIs: chainable `setup(...).setAutoCollectRequests(...).start()`
  and `client.addTelemetryProcessor(...)` with envelope `process()` callbacks.
- I first installed `applicationinsights@^3` and discovered the v3 shim
  silently deprecates `addTelemetryProcessor` to a no-op that only logs
  `addTelemetryProcessor is not supported in ApplicationInsights any
  longer.` v3 is built on `@azure/monitor-opentelemetry` and expects OTel
  `SpanProcessor` registration via `useAzureMonitor({ spanProcessors })`.
- Pinned to `applicationinsights@^2.9.0` (`apps/api/package.json`). v2.x is
  still maintained for "classic" customers and is what the Azure Functions
  Node v4 host expects when `ApplicationInsightsAgent_EXTENSION_VERSION=~3`
  attaches at runtime. Migrating to v3 is a separate, much larger piece of
  work (would also require rewriting the redactor as an OTel SpanProcessor)
  and is intentionally deferred.
- `_telemetryProcessors` is on `TelemetryClient` itself (private field), NOT
  on `client.config` as the task spec hinted. The test asserts
  `(client as unknown as { _telemetryProcessors: unknown[] })._telemetryProcessors.length === 1`.

### TS type-shim between TelemetryEnvelope and EnvelopeTelemetry
- v2's `addTelemetryProcessor` signature expects `(envelope: Contracts.EnvelopeTelemetry, ctx?: { [name: string]: any }) => boolean`.
  Our redactor uses a structural `TelemetryEnvelope` interface (minimal,
  SDK-agnostic, deliberately reusable for the browser SDK port). The two
  types are structurally compatible but TS's structural-typing inference
  trips on `data: DataTelemetry` (which has named fields) vs
  `data: { [key: string]: unknown; baseData?: ... }` (open index sig).
- Resolved with a wrapper closure that casts at the boundary in
  `apps/api/src/lib/telemetry.ts` — single `as unknown as TelemetryEnvelope`
  cast in one place, contained to the SDK-adapter layer. The redactor's
  public surface stays SDK-agnostic.

### Init-order invariant
- `setupTelemetry()` MUST run BEFORE the `./functions/*.js` imports in
  `apps/api/src/index.ts`. Once any function module registers via
  `app.http(...)` and the AI agent attaches its auto-collectors, the first
  inbound request envelope can fire before a later-registered processor
  sees it.
- Added a multi-line comment in `index.ts` flagging this — without it a
  future contributor could reorder imports (alphabetisation, lint
  auto-fix) and silently leak PII with no test/type signal.
- `setup()` is idempotent — guarded by a module-local `initialised` flag —
  to survive vitest's parallel `import` graph and any defensive double-call
  from the Functions host. The "is idempotent" test confirms only one
  processor is registered after two `setup()` calls.

### Local-dev no-op contract
- `setup()` reads `APPLICATIONINSIGHTS_CONNECTION_STRING`. If absent or
  whitespace-only, it logs ONE warning (`[telemetry] APPLICATIONINSIGHTS_CONNECTION_STRING not set — telemetry disabled (local-dev mode)`)
  and returns. No SDK init, no auto-collector attachment, no network call,
  no startup blockage.
- `apps/api/local.settings.json` is unchanged by this task — the absence of
  the env var IS the local-dev signal. Documented in `iac/insights.tf` and
  in this notepad.

### Test pattern for envelope inspection
- Replaced `client.channel.send` with an in-memory capture sink AFTER
  `setup()` runs. The v2 SDK still executes the full processor pipeline
  before invoking `channel.send`, so the captured envelope reflects exactly
  what would have been transmitted.
- Asserted PII absence two ways: (a) field-level lookup (`props["email"] === "***"`)
  and (b) full-envelope `JSON.stringify(envelope)` substring search for the
  raw PII values — the substring check catches accidental leaks into adjacent
  fields (`tags`, `customMeasurements`, etc.) that field-level asserts would
  miss.

### SPA RUM include/defer decision — DEFERRED with stub
- The task spec explicitly allows: *"if size concern, defer SPA RUM to a
  follow-up and STUB the import — document choice in learnings."*
- `@microsoft/applicationinsights-web` is ~50KB gzipped (verified via the
  npm registry pages). The current SPA gzipped bundle is 102.90KB; adding
  RUM would push it to ~150KB. With no concrete RUM use case in scope for
  T46/T47 (alerts in T47 fire off API-side metrics only), the cost/benefit
  did not justify the bundle bloat for go-live.
- `apps/web/src/lib/telemetry.ts` is a self-contained stub: it ports
  `redactObject` + `PII_FIELDS` to TS as a no-runtime-dep utility (kept in
  sync with `apps/api/src/lib/telemetryRedactor.ts` — same dual-maintenance
  note as the existing `scripts/lib/pii.mjs` ↔ telemetryRedactor.ts pair),
  reads `VITE_APP_INSIGHTS_CONNECTION_STRING`, and if present logs a single
  info line saying RUM is stubbed. When RUM is enabled (Wave 8+), the only
  change required is to swap the `console.info` for an
  `ApplicationInsights` init that registers a `addTelemetryInitializer`
  wrapping every envelope through `redactObject`.
- `apps/web/src/main.tsx` calls `setupTelemetry()` BEFORE `createRoot(...)`
  for the same init-order reason as the API.
- No new npm dep added to `apps/web/package.json`; no bundle-size change.

## Task 47 notes — Monitor alerts in Terraform + runbook

### Final alert design (6 rules + 1 action group, all routing to ag-bccweb-prod-ops)

| # | Resource | Type | Severity | Window | Rationale |
|---|---|---|---|---|---|
| 1 | api_5xx_rate | scheduled_query_rules_alert_v2 | 1 | 5m | rate>1% AND errors>=5 (absolute floor stops near-zero traffic false positives) |
| 2 | function_execution_failures | scheduled_query_rules_alert_v2 | 2 | 5m | requests.success==false count > 10 |
| 3 | storage_server_errors | metric_alert | 1 | 5m / 1m freq | Transactions metric dim ResponseType IN [ServerBusyError, ServerOtherError] > 5 |
| 4 | auth_lockout_spike | scheduled_query_rules_alert_v2 | 2 | 15m | traces where message has "[METRIC] auth.lockout.triggered" count > 5 |
| 5 | lockround_p95_duration | scheduled_query_rules_alert_v2 | 2 | 30m | requests where name==lockRound; p95 > 30000ms (with n>=3 sample floor) |
| 6 | recompute_marker_stale | scheduled_query_rules_alert_v2 | 2 | 15m | traces where message has "[METRIC] recompute.marker.stale" |

### Metric vs log-query tradeoffs (decisions made)

- **Why scheduled query for 5xx rate (not metric):** `Microsoft.Web/sites.Http5xx` and `Requests` are separate metrics with no ratio operator in `azurerm_monitor_metric_alert`. A multi-metric `criteria` block expects scalar comparisons, not ratios. Doing the rate in KQL is the only option that gives a true percentage rather than absolute count.
- **Why scheduled query for function-failures (not metric):** `FunctionExecutionCount` does NOT expose a `Status` dimension at the platform-metric layer — the original task spec was inaccurate on this point. App Insights `requests.success == false` is the only reliable per-execution success/failure source.
- **Why metric alert for storage (not log query):** `Microsoft.Storage/storageAccounts.Transactions` with the `ResponseType` dimension is a first-class platform metric. Going via Log Analytics would add latency and cost vs the direct metric path. `ServerBusyError` covers HTTP 503 throttling; `ServerOtherError` covers generic 5xx.
- **Auth lockout via traces (not customEvents):** T16 emits `[METRIC] auth.lockout.triggered` via `console.warn`, which the AI Node.js auto-instrumentation surfaces in the `traces` table — NOT `customEvents`. (The plan brief said customEvents but that would require an explicit `trackEvent` call which T16 did not wire.)
- **Recompute marker stale is forward-looking:** No code path currently emits `[METRIC] recompute.marker.stale`. The alert resource is in place so the emitter can ship later without an additional terraform apply. Documented as "will not fire until emitter ships" in the runbook so on-call doesn't worry about silence.

### azurerm_monitor_scheduled_query_rules_alert_v2 schema gotchas (azurerm 3.117.1)

- `action.action_groups` is a LIST of action-group IDs (not singular `action_group_id` as on `metric_alert`).
- `criteria.failing_periods` is REQUIRED — omitting it fails plan.
- `criteria.time_aggregation_method = "Count"` + `threshold = 0` + `operator = "GreaterThan"` is the canonical "fire when the KQL projects any rows" pattern. The KQL itself does the real filtering via `where ... > threshold` before `project`.
- `skip_query_validation = true` lets plan succeed without Log Analytics workspace credentials at plan time (the workspace doesn't exist yet on first apply).
- `workspace_alerts_storage_enabled = false` avoids requiring a workspace storage account.
- KQL must be inside an HCL heredoc (`<<-KQL ... KQL`). `terraform fmt` preserves indentation correctly.

### azurerm_monitor_metric_alert dimension syntax

- `dimension { name = "ResponseType"; operator = "Include"; values = ["ServerBusyError", "ServerOtherError"] }` — `values` is a list, multiple values are OR'd together.
- `frequency = "PT1M"` with `window_size = "PT5M"` evaluates every minute over a rolling 5-minute window (catches bursts faster than 5m/5m).

### azurerm_monitor_action_group conditional receivers

- `dynamic "webhook_receiver" { for_each = var.slack_webhook_url != "" ? [var.slack_webhook_url] : [] ... }` — the empty-list pattern is the idiomatic conditional-block approach in 3.x (cleaner than `count` because `count` isn't supported on nested blocks).
- `short_name` is capped at 12 chars by the Azure API. Chose `bccops`.
- `use_common_alert_schema = true` on both receivers so downstream tooling (Slack formatters, PagerDuty integrations) receives a consistent payload shape.

### var.ops_email validation

- Used `validation { condition = length(trimspace(var.ops_email)) > 0 && can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.ops_email)) ... }`.
- No default → deploys fail closed if the operator forgets to set it. Aligns with "alerts without a recipient are worse than no alerts" from the task brief.

### Plan verification numbers

- 6 alert rules + 1 action group, every alert references `azurerm_monitor_action_group.ops.id` via config-tree expression (confirmed via `jq '.configuration.root_module.resources[]'` — `change.after.action_groups` shows `after_unknown: true` because the action group's ID is itself known-after-apply).
- Total plan delta: 27 to add, 0 to change, 0 to destroy.
- Plan command: `terraform plan -out=plan.binary -var-file=terraform.tfvars.example` (no `-backend=false` needed; `terraform init -backend=false` first).
- Evidence: `.omo/evidence/task-47-alerts.txt`.
