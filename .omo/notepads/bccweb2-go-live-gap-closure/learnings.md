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
