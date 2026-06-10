# Testing Infrastructure for bccweb2

## TL;DR

> **Quick Summary**: Build a three-layer testing capability — `docker compose up` produces a stack with a pre-seeded admin user (random password printed); a bulk fixture script seeds 500 login-capable pilots / 50 clubs / 100 club-teams via direct Blob SDK writes; a k6-based 5-step pipeline load-tests the full sign-to-fly journey (register-self under load → brief-complete transition → sign under load) against the round-blob lease bottleneck. **Local docker by default; the same pipeline targets a dedicated Azure test Function App via env vars (`BCC_API_BASE_URL`, `BLOB_CONNECTION_STRING`, `ADMIN_PASSWORD`).** The plan also refactors the `register-self` rate-limit key from IP to `pilotId` — this fixes a latent production bug (shared-NAT pilots at hill sites stealing each other's 10/min budget) AND eliminates the need for any test-only bypass apparatus.
>
> **Deliverables**:
> - `api-init` docker-compose service that bootstraps `admin@bcc.local` with a random per-stack password, printed to stderr in ANSI-yellow + persisted to gitignored `.dev-credentials`
> - `scripts/seed-fixtures.mjs` — wipe-and-reseed 500 pilots + 50 clubs + 100 teams + season + sites + `config.json`
> - `scripts/seed-rounds.mjs` — 3–5 dev-browsing rounds in Proposed/Confirmed/BriefComplete/Locked statuses
> - `scripts/{prepare,transition,cleanup}-loadtest.mjs` + `tests/load/sign-to-fly.js` — 5-step k6 pipeline (prepare → register → transition → sign → cleanup) chained by `make loadtest`
> - Refactored `apps/api/src/lib/rateLimit.ts` accepting optional `identityKey` (fail-safe IP fallback); `roundRegistration.ts` uses `identityKey: caller.pilotId` so the 500-VU load test fits the 10/min/pilot budget without test-only env vars
> - `PURETRACK_ENABLED=false` guard preventing live PureTrack calls during dev/load test
> - `docs/runbooks/load-testing.md`
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES — 5 implementation waves + 1 final verification wave
> **Critical Path**: T2 (blobSeed) → T8 (seed-fixtures) → T11 (prepare-loadtest) → T15 (k6 script) → T16 (Makefile) → F1-F4 → user okay. This is the longest dependency chain that gates the final loadtest pipeline.

---

## Context

### Original Request

User wants three layers of testing capability:

1. **Dev environment with seeded admin** — `docker compose up` produces a working stack with a pre-created admin account; credentials printed in output so the user can log in immediately.
2. **Bulk fixture generator** — Programmatically create realistic test data: 500 pilots registered, 50 clubs, two teams per club. Data can be generated (e.g. `club1`, `club2`).
3. **Load test for sign-to-fly journey** — Eventually be able to load-test the sign-to-fly journey: create round → pilots register for round → captains make teams → round brief created → pilots sign-to-fly during a 15-min window.

### Interview Summary

**Decisions made**:
- Admin credentials: fixed email `admin@bcc.local`, random password regenerated per fresh stack, printed to compose output.
- Tool: k6. Default target is the local docker stack; same scripts target a dedicated Azure test Function App when `BCC_API_BASE_URL` + `BLOB_CONNECTION_STRING` + `ADMIN_PASSWORD` env vars are set.
- All 500 pilots login-capable (one pre-computed bcrypt-12 hash shared across all).
- Wipe-and-reseed semantics for re-running fixtures; deterministic UUIDs derived from index.
- Load test scope: full journey (register-self + sign), not just sign.
- k6 thresholds: NONE configured. k6's `options.thresholds` always gates exit code (no advisory variant); operator observes summary stats from k6 stdout instead. Latency/error metrics are read but not enforced.
- Pre-seeded rounds: yes — separate optional `seed-rounds.mjs` for 3–5 dev-browsing rounds.

**Research Findings** (verified against code):
- Current docker-compose has azurite + azurite-init + api + web. No admin bootstrap exists; admins are created today via manual `scripts/admin-users.mjs set-roles`.
- Auth model: pilot, user, auth credential, email index, user index — five distinct private blobs per login-capable pilot. bcryptjs cost 12.
- Public denormalization (`pilots.json`, `clubs.json`, `club-teams.json`) must be maintained or the SPA breaks.
- Sign-to-fly bottleneck: the single private round blob's lease serializes ALL signs for one round. This is the contention to measure.
- **Brief blob creation (closed)**: Originally there was NO HTTP endpoint to create the initial `round-briefs/{id}.json`. The brief-lifecycle-fix plan (`.omo/plans/brief-lifecycle-fix.md`) has landed: `confirmRound` now writes the skeleton brief via `buildRoundBrief()` at `apps/api/src/functions/roundsMutate.ts:397-400`; `lockRound` uses `mergeBriefForLock()` at `roundsMutate.ts:566+` to preserve narrative while refreshing derived fields. As a result, T9 and T11 use the API only — no Blob SDK calls for briefs anywhere in this plan.
- **k6 uses a Goja ES5.1 VM, not Node**. No Azure Blob SDK in k6 scripts; all blob writes must happen in adjacent Node scripts.
- **Status guards force the load test into a 5-step pipeline**: register-self requires `Proposed`/`Confirmed` (roundRegistration.ts:32,51,206-208); sign requires `BriefComplete` (signatures.ts:64-65). Brief-complete transition must happen BETWEEN the register phase and the sign phase.
- T&Cs gate: `User.acceptedTsCsVersion < TS_CS_VERSION` (=1, `termsConstants.ts:1`) triggers `FirstLoginOfSeasonGate`. Fixture pilots must have `acceptedTsCsVersion: TS_CS_VERSION`. Login requires `auth/{userId}.json.emailVerified === true` (`authFunctions.ts:374`).
- `config.json` default `maxPilotsInTeam` is 5 (`roundRegistration.ts:189`). Fixture must write `config.json` with `maxPilotsInTeam: 10` for the 50-team × 10-slot round to fit 500 pilots.

### Metis Review

**Critical guardrails (incorporated)**:
- Admin seed MUST be idempotent.
- Pre-hash ONE bcrypt-12 hash once and share — never call `bcrypt.hash()` 500 times.
- Deterministic UUIDs from index for surgical wipe-by-known-ID.
- 5-layer defense for rate-limit bypass (refuse-to-start in Azure + runtime warning + scoped check + CI gate + docs hygiene). **SUPERSEDED**: replaced by identity-keyed rate limit (T5) which removes the need for any bypass.
- PureTrack MUST be disabled in the dev stack via env-var guard.
- Privacy scan MUST run as post-fixture acceptance check.

**Defaults applied silently**: see "Auto-Resolved Defaults" section in draft.

---

## Work Objectives

### Core Objective

Provide a turnkey testing capability covering three layers: instant `docker compose up` with seeded admin, bulk fixture generation for realistic dev data, and a k6-based load test that exercises the full sign-to-fly journey end-to-end against the contention bottleneck. Local docker is the default target; the same scripts target a dedicated Azure test Function App via env-var configuration (no separate "Azure variant" — one set of scripts, two modes).

### Concrete Deliverables

- `api-init` docker-compose service that runs `scripts/seed-admin.mjs`, prints credentials to stderr, and writes gitignored `.dev-credentials`.
- `scripts/seed-admin.mjs`, `scripts/seed-fixtures.mjs`, `scripts/seed-rounds.mjs`, `scripts/wipe-fixtures.mjs`.
- `scripts/prepare-loadtest.mjs`, `scripts/transition-loadtest.mjs`, `scripts/cleanup-loadtest.mjs`.
- `scripts/lib/blobSeed.mjs`, `scripts/lib/loadTestConsts.mjs` — shared helpers/constants. `loadTestConsts.mjs` exposes `BCC_API_BASE_URL`, `IS_AZURE_TARGET`, `ADMIN_PASSWORD_OVERRIDE` for dual-mode (local docker / Azure dedicated test instance).
- `tests/load/sign-to-fly.js` (k6) + `tests/load/README.md` (covers both local and Azure operation).
- API hardening: `rateLimit.ts` accepts optional `identityKey` (IP fallback), `roundRegistration.ts` passes `caller.pilotId`. `PURETRACK_ENABLED=false` guard.
- `docker-compose.yml` updates (api-init service + `PURETRACK_ENABLED=false`).
- `Makefile` targets: `seed`, `seed-rounds`, `wipe-fixtures`, `loadtest-{prepare,register,transition,sign,cleanup}`, `loadtest` (chain). All targets pass through env vars (`BCC_API_BASE_URL`, `BLOB_CONNECTION_STRING`, `ADMIN_PASSWORD`) so the same `make loadtest` works against local or Azure.
- `docs/runbooks/load-testing.md` covering both local docker mode AND Azure dedicated-test-instance mode (Function App env vars, warm-up phase, cost/data hygiene).
- `.gitignore` entries for `.dev-credentials`, `.fixture-manifest.json`, `tests/load/.prepared-round.json`.

### Definition of Done

- [x] `touch .dev-credentials && docker compose down -v && docker compose up --build` ⇒ admin credentials visible in compose log within 60s; `curl POST /api/auth/login` with those credentials returns 200 + JWT with `Admin` role. (verified via podman-compose; see .omo/evidence/final-qa/01-fresh-stack.txt)
- [ ] `make seed` ⇒ `pilots.json` has 500 entries, `clubs.json` 50, `club-teams.json` 100. `curl POST /api/auth/login` with `pilot001@bcc.local` returns 200.
- [ ] `make seed-rounds` ⇒ rounds list page in SPA shows 4 rounds in varied statuses, all signable rounds have valid `round-briefs/{id}.json`.
- [ ] **Step-by-step load test** (LOCAL): `make loadtest-prepare && make loadtest-register && make loadtest-transition && make loadtest-sign` completes; assert round blob has 500 slots with `signToFly=true` via `GET /api/rounds/{id}` BEFORE running `make loadtest-cleanup`. Wall-clock sign phase < 15 min.
- [ ] **Step-by-step load test** (AZURE-TARGET): same pattern, executed against a dedicated Azure test Function App configured per the runbook. Acceptable wall-clock window 25 min (accommodates cold starts + remote network).
- [ ] `node scripts/privacy-scan.mjs` PASS after `make seed`.
- [ ] `make test` PASS after all API hardening changes (this uses Vitest in workspace mode across all packages).
- [ ] Rate-limit isolation test: two pilots sharing one IP each get their own 10/min budget on `register-self` (proves identityKey is in effect).
- [ ] Dual-mode proof: same script (`prepare-loadtest.mjs`) run with `unset BCC_API_BASE_URL` (local) vs. `BCC_API_BASE_URL=https://...` (Azure) targets the respective endpoints; the emitted `.prepared-round.json` reflects the active target.

### Must Have

- Bulk fixture data (pilots/clubs/teams/users/auth/config) uses direct Blob SDK writes — never HTTP API (because of bcrypt + lease serialization at scale). Round and brief lifecycle, by contrast, go through the production API (see brief-creation rule below).
- Pre-computed bcrypt-12 hash shared across all 500 pilots (compute ONCE, reuse string).
- Deterministic UUIDs derived from pilot/club/team index (so wipe-by-known-ID is O(1) per record).
- `rateLimit.ts` accepts an optional `identityKey` parameter; when present, used in place of IP as the bucket key. When absent, IP keying preserved (no regression for the 7 anonymous-or-token endpoints).
- `roundRegistration.ts` passes `identityKey: caller.pilotId ?? ("anon:" + ip)` so login-failed/anon edge cases still get IP-keyed limiting; happy path is per-pilot.
- `PURETRACK_ENABLED=false` short-circuit in `apps/api/src/lib/puretrack.ts` BEFORE any outbound HTTP.
- k6 scripts are pure HTTP — no Blob SDK, no `fs`, no npm packages; only `k6/http`, `k6`, `k6/data`, and the global `open()` init-context helper.
- Brief blobs created via the production API only (`POST /api/rounds/{id}/confirm` auto-creates skeleton brief; `PUT /api/rounds/{id}/brief` for narrative; `POST /api/rounds/{id}/lock` refreshes via `mergeBriefForLock`). Direct Blob SDK writes to `round-briefs/*` are forbidden in this plan — see Must NOT Have.
- Public denormalization indexes (`pilots.json`, `clubs.json`, `club-teams.json`) updated in lockstep with private blob writes.
- `User.acceptedTsCsVersion = TS_CS_VERSION` (imported from `apps/api/src/lib/termsConstants.ts`, currently 1) and `auth/{userId}.json.emailVerified = true` for all fixture users.
- `config.json` written with `maxPilotsInTeam: 10` so the 50-team load-test round can fit 500 pilots.
- Random admin password printed to **stderr** (unbuffered, ANSI-yellow, high-visibility prefix `=== BCC ADMIN PASSWORD: ... ===`) AND written to gitignored `.dev-credentials` (local mode only — Azure mode uses the `ADMIN_PASSWORD` env var).
- **Dual-mode env awareness**: every Node script in `scripts/` that makes HTTP calls reads `BCC_API_BASE_URL` (default `http://localhost:7071`). Admin credential resolution prefers `ADMIN_PASSWORD` env var over `.dev-credentials`, allowing Azure operation without a `.dev-credentials` file on the operator's laptop.
- **Same `make loadtest` works for both modes**: the operator switches target by setting env vars before running, never by editing scripts or running a different command.
- Privacy scan passes after fixture seed.

### Must NOT Have (Guardrails)

- NO HTTP API for bulk fixture writes (would take many minutes due to bcrypt + lease serialization).
- NO `bcrypt.hash()` called more than once during fixture seed (compute once, share).
- NO imports from `apps/api/src/` in `scripts/*.mjs` (scripts are standalone with only their own dependencies on `@azure/storage-blob` and `bcryptjs`).
- NO Azure Blob SDK calls inside k6 scripts (impossible — Goja runtime).
- NO `fs` writes, `require()`, or npm imports inside k6 scripts.
- NO env-var-gated rate-limit bypass — the identity-keyed rate limit removes the need entirely. Any commit re-introducing `ALLOW_TEST_RATE_LIMIT_BYPASS` or equivalent SHOULD be rejected.
- NO change to the rate-limit key strategy for the 7 other endpoints (login/register/refresh/forgot-password/reset-password/verify-email/resend-verification) — those stay IP-keyed.
- NO production PureTrack calls during dev or load tests — guard checks `PURETRACK_ENABLED` BEFORE outbound HTTP.
- NO writing of admin password to any blob (Azurite or otherwise) — stdout/stderr and `.dev-credentials` (gitignored) only.
- NO additional infra (Grafana/InfluxDB/Prometheus) for k6 results — stdout + `--out csv` only.
- NO seeding of flights/results/scores (only round shells, no scoring data).
- NO mutation of existing `scripts/admin-users.mjs` or `scripts/init-storage.mjs` (additive only).
- NO new HTTP endpoints — the brief-lifecycle-fix plan added the necessary `confirmRound`/`lockRound` brief lifecycle; nothing more is needed here.
- **NO direct Blob SDK writes to `round-briefs/*` in any seed or load-test script.** The brief-lifecycle fix made the API the single source of truth for brief creation. T9 and T11 use `POST /api/rounds/{id}/confirm`. Any script that imports `@azure/storage-blob` and writes to a `round-briefs/` path SHOULD be rejected.
- NO test pilots without `acceptedTsCsVersion` set (would trigger `FirstLoginOfSeasonGate` and break login).
- NO test users without `emailVerified: true` in their auth blob (login returns 403 otherwise).
- **NO hardcoded `http://localhost:7071`** in any script. The constant `BCC_API_BASE_URL` from `loadTestConsts.mjs` is the only API endpoint reference; scripts that need it import it from there.
- **NO automatic enforcement of "no prod"** — the safety convention (BCC_API_BASE_URL must contain "loadtest" or "staging") is documented in the runbook but not code-enforced. The operator is responsible for not pointing this at production. Adding code-level prod detection is explicitly out of scope; it's brittle (URL patterns vary) and the dedicated-test-instance assumption makes it unnecessary.
- NO `make loadtest-prod` or similar target. The dual-mode is "local" vs "user-configured Azure target"; there is no preset for any specific Azure instance.

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (Vitest 4.1.8, `make test` requires Azurite up).
- **Automated tests**: tests-after for API code changes (PureTrack guard at T4, rate-limit identityKey refactor at T5). Vitest with existing setup (mocked `@azure/functions`, real Azurite for blob ops).
- **Framework**: existing Vitest.
- **Scripts/k6**: no unit tests. Verified by Agent-Executed QA scenarios — actually running the scripts and asserting blob/HTTP state.

### QA Policy
Every task includes agent-executed QA scenarios. Evidence saved to `.omo/evidence/task-{N}-{slug}.{ext}`.

- **Compose service**: `bash` with `docker compose up -d`, log grep for credentials, `curl` login.
- **Node scripts**: `bash` to run script, then `curl` + `jq` against blob endpoints OR small Node one-liner using `@azure/storage-blob` to list/read blobs.
- **API code**: Vitest test + `bash` runtime check (start API, hit endpoint, assert response).
- **k6 script**: `interactive_bash` (tmux) running k6 to capture live output; post-run blob read to verify `signToFly=true` count.
- **CI workflow**: `act` or manual GitHub workflow dispatch with a deliberately injected bad env var to verify failure.

---

## Execution Strategy

### Parallel Execution Waves

> Waves represent strict dependency batches: every task in wave N must complete before wave N+1 starts. Waves are split where intra-wave dependencies exist (e.g., T9 depends on T8, so T9 cannot be in the same wave as T8).

```
Wave 1 (Start Immediately — foundation, 5 parallel):
├── T1: .gitignore entries [quick]
├── T2: scripts/lib/blobSeed.mjs (shared blob helpers + bcrypt + UUIDs) [unspecified-high]
├── T3: scripts/lib/loadTestConsts.mjs (shared constants) [quick]
├── T4: API: PureTrack guard (PURETRACK_ENABLED=false short-circuit) [unspecified-high]
└── T5: API: rateLimit identityKey + roundRegistration uses caller.pilotId [unspecified-high]

Wave 2 (After Wave 1 — first wave-1-dependents, 5 parallel):
├── T6: docker-compose.yml env: PURETRACK_ENABLED=false [quick]
├── T7: scripts/seed-admin.mjs (idempotent admin bootstrap) [unspecified-high]
├── T8: scripts/seed-fixtures.mjs (500 pilots/50 clubs/100 teams/season/sites/config) [deep]
├── T10: scripts/wipe-fixtures.mjs (wipe-by-manifest) [quick]
└── T12: scripts/transition-loadtest.mjs (POST brief-complete) [quick]

Wave 3 (After Wave 2 — second-tier scripts + api-init, 3 parallel):
├── T9: scripts/seed-rounds.mjs (pure HTTP, drives rounds through API lifecycle) [unspecified-high]
├── T11: scripts/prepare-loadtest.mjs (pure HTTP; brief auto-creates on confirm) [unspecified-high]
└── T14: docker-compose api-init service (runs seed-admin, prints credentials) [unspecified-high]

Wave 4 (After Wave 3 — cleanup + k6, 2 parallel):
├── T13: scripts/cleanup-loadtest.mjs (delete round + cleanup) [quick]
└── T15: tests/load/sign-to-fly.js (k6 script, PHASE=register|sign) [deep]

Wave 5 (After Wave 4 — orchestration + docs, 3 parallel):
├── T16: Makefile targets (seed, loadtest-*, loadtest chain) [quick]
├── T17: tests/load/README.md [writing]
└── T18: docs/runbooks/load-testing.md [writing]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real manual QA (unspecified-high)
└── F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: T2 → T8 → T11 → T15 → T16 → F1-F4 → user okay (longest chain)
Parallel Speedup: ~70% faster than sequential
Max Concurrent: 5 (Waves 1 & 2)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| T1   | —         | (none — independent) |
| T2   | —         | T7, T8, T10, T13 |
| T3   | —         | T7, T8, T9, T10, T11, T12, T13, T15 |
| T4   | —         | T6 |
| T5   | —         | T15 (rate-limit must be in place before k6 register phase) |
| T6   | T4        | T14 |
| T7   | T2, T3    | T14 |
| T8   | T2, T3    | T9, T11, T16 |
| T9   | T3, T8    | T16 |
| T10  | T2, T3    | T16 |
| T11  | T3, T8    | T15, T16 |
| T12  | T3        | T16 |
| T13  | T3, T11   | T16 |
| T14  | T6, T7    | — |
| T15  | T3, T5, T11 | T16, T17 |
| T16  | T7-T13, T15 | — |
| T17  | T15       | — |
| T18  | T15, T16  | — |

### Agent Dispatch Summary

| Wave | Count | Dispatch |
|------|-------|----------|
| 1 | 5 | T1 → `quick`, T2 → `unspecified-high`, T3 → `quick`, T4 → `unspecified-high`, T5 → `unspecified-high` |
| 2 | 5 | T6,T10,T12 → `quick`; T7 → `unspecified-high`; T8 → `deep` |
| 3 | 3 | T9, T11, T14 → `unspecified-high` |
| 4 | 2 | T13 → `quick`; T15 → `deep` |
| 5 | 3 | T16 → `quick`; T17, T18 → `writing` |
| FINAL | 4 | F1 → `oracle`; F2 → `unspecified-high`; F3 → `unspecified-high`; F4 → `deep` |

---

## TODOs

- [x] 1. .gitignore: add entries for dev credentials and load-test artifacts - prevent secrets in git

  **What to do**:
  - Append to `.gitignore` at repo root: `.dev-credentials`, `.fixture-manifest.json`, `tests/load/.prepared-round.json`.
  - Verify entries don't already exist; if any exists, leave it (idempotent).

  **Must NOT do**:
  - Modify any other `.gitignore` patterns.
  - Add ignore rules for files not listed.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: trivial single-file append, no logic.
  - **Skills**: none
  - **Skills Evaluated but Omitted**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T2, T3, T4, T5)
  - **Blocks**: none
  - **Blocked By**: none

  **References**:

  *Pattern References*:
  - `.gitignore` (existing root file) - append style, blank-line separation between sections.

  *Why Each Reference Matters*:
  - Preserve existing style: each ignore entry on its own line; keep section comments if there are any.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: All three entries are ignored
    Tool: Bash
    Preconditions: Repo at clean state.
    Steps:
      1. Run: `touch .dev-credentials .fixture-manifest.json tests/load/.prepared-round.json` (mkdir tests/load if needed)
      2. Run: `git status --short | grep -E '\.dev-credentials|\.fixture-manifest\.json|\.prepared-round\.json'`
    Expected Result: grep exits 1 (no output) — none of the three files appear in `git status`.
    Failure Indicators: any of the three appears in `git status` output.
    Evidence: `.omo/evidence/task-1-gitignore-effective.txt` (output of `git check-ignore -v <each path>`).

  Scenario: Pre-existing entries remain intact
    Tool: Bash
    Preconditions: Run `git diff .gitignore` before and after.
    Steps:
      1. Capture `wc -l .gitignore` before
      2. Apply change
      3. Capture `wc -l .gitignore` after
      4. `git diff .gitignore` shows ONLY added lines, zero removed.
    Expected Result: only `+` lines in diff, no `-` lines.
    Evidence: `.omo/evidence/task-1-gitignore-diff.txt`.
  ```

  **Commit**: YES
  - Message: `chore(gitignore): ignore dev credentials and load-test artifacts`
  - Files: `.gitignore`
  - Pre-commit: `git check-ignore -v .dev-credentials`

- [x] 2. scripts/lib/blobSeed.mjs: create shared blob-write helper lib for fixture/admin scripts - reusable primitives for all seed scripts

  **What to do**:
  - Create `scripts/lib/blobSeed.mjs` (ESM, Node, no TS — matches existing `scripts/*.mjs` style).
  - Export:
    - `getBlobServiceClient()` — reads `BLOB_CONNECTION_STRING` env (or defaults to Azurite well-known string when missing/`localhost`).
    - `getPublicContainer()` / `getPrivateContainer()` — returns `ContainerClient` for `data` / `data-private`.
    - `writeJson(container, path, obj)` — JSON.stringify + upload + `Content-Type: application/json`.
    - `readJson(container, path)` — download + parse; returns `null` on 404.
    - `deleteBlob(container, path)` — delete-if-exists.
    - `listBlobs(container, prefix)` — async iterator returning blob names.
    - `deterministicUuid(namespace, name)` — uses `crypto.createHash('sha256').update(`${namespace}:${name}`).digest('hex')` and formats as UUIDv5-shape `xxxxxxxx-xxxx-5xxx-axxx-xxxxxxxxxxxx`.
    - `precomputeBcryptHash(plaintext)` — async; calls `bcryptjs.hash(plaintext, 12)` ONCE; returns the resulting hash string. (Caller should call this once and reuse.)
    - `upsertPublicIndex(path, entry, keyField)` — read existing array (or `[]`), upsert by `keyField`, sort by `name` or `id`, write back. Handles `pilots.json`, `clubs.json`, `club-teams.json`, etc.
    - `removeFromPublicIndex(path, idValue, keyField)` — read, filter out, write back.
  - Add `bcryptjs` to root `package.json` devDependencies if not already present (`scripts/admin-users.mjs` may already depend on it — check first).

  **Must NOT do**:
  - Import from `apps/api/src/` (scripts are standalone — they share patterns, not modules).
  - Use TypeScript (`.mjs` only — matches `scripts/admin-users.mjs`).
  - Add any framework deps (no Vitest, no test setup in this file).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: small lib but touches multiple concerns (blob, bcrypt, UUIDs) and is critical foundation.
  - **Skills**: none
  - **Skills Evaluated but Omitted**:
    - `customize-opencode`: not relevant — this is product code.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T7, T8, T10, T13
  - **Blocked By**: none

  **References**:

  *Pattern References*:
  - `scripts/admin-users.mjs` — existing standalone Node script; same style (ESM `.mjs`, top-level await OK, uses `@azure/storage-blob` directly).
  - `scripts/init-storage.mjs` — shows container creation pattern with `BLOB_CONNECTION_STRING` default to Azurite.
  - `apps/api/src/__tests__/helpers/seed.ts:85,99+` — `SeedUserOptions` interface + `makeUser` factory; reference for `upsertPublicIndex` patterns (don't import; replicate).
  - `apps/api/src/lib/blob.ts:70-80` — `writePublicJson` / `writePrivateJson` / `*BlobExists` helpers; reference for public vs private container split.

  *API/Type References*:
  - `packages/types/src/index.ts` - `PilotSummary`, `ClubSummary`, `ClubTeamSummary` shapes (no PII allowed in summaries).

  *External References*:
  - `@azure/storage-blob` docs - `BlobServiceClient.fromConnectionString`, `ContainerClient.getBlockBlobClient(...).upload(string, length, { blobHTTPHeaders })`.
  - bcryptjs docs - `bcrypt.hash(pw, 12)` returns `$2b$12$...` string.
  - Azurite well-known connection string: `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;`

  *WHY Each Reference Matters*:
  - `admin-users.mjs` shows the exact `.mjs` style we must match (no TS, no transpile, runs with `node` directly).
  - `init-storage.mjs` shows the Azurite connection-string default pattern — reuse it.
  - The `seed.ts` helpers know exactly which fields to include in each public summary; replicating the field selection here prevents PII leaks.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: deterministicUuid is stable across runs
    Tool: Bash
    Preconditions: scripts/lib/blobSeed.mjs created.
    Steps:
      1. Run: `node -e "import('./scripts/lib/blobSeed.mjs').then(m => { console.log(m.deterministicUuid('pilot', 'pilot001')); console.log(m.deterministicUuid('pilot', 'pilot001')); })"`
    Expected Result: same UUID printed twice, valid UUIDv5-shape (length 36, hyphens at correct positions, version nibble = 5).
    Evidence: `.omo/evidence/task-2-deterministic-uuid.txt`.

  Scenario: precomputeBcryptHash + bcrypt.compare round-trip
    Tool: Bash
    Preconditions: bcryptjs installed.
    Steps:
      1. Run: `node -e "import('./scripts/lib/blobSeed.mjs').then(async m => { const h = await m.precomputeBcryptHash('test-pw'); const b = await import('bcryptjs'); console.log(await b.default.compare('test-pw', h)); console.log(h.startsWith('$2b$12$') || h.startsWith('$2a$12$')); })"`
    Expected Result: prints `true` then `true`.
    Evidence: `.omo/evidence/task-2-bcrypt-roundtrip.txt`.

  Scenario: writeJson/readJson round-trip against Azurite
    Tool: Bash
    Preconditions: `docker compose up -d azurite azurite-init` running.
    Steps:
      1. Run: `node -e "import('./scripts/lib/blobSeed.mjs').then(async m => { const c = m.getPrivateContainer(); await m.writeJson(c, 'task2-test.json', {hello: 'world'}); console.log(JSON.stringify(await m.readJson(c, 'task2-test.json'))); await m.deleteBlob(c, 'task2-test.json'); console.log(await m.readJson(c, 'task2-test.json')); })"`
    Expected Result: prints `{"hello":"world"}` then `null`.
    Evidence: `.omo/evidence/task-2-blob-roundtrip.txt`.

  Scenario: upsertPublicIndex sorts and dedupes
    Tool: Bash
    Preconditions: Azurite running.
    Steps:
      1. Call `upsertPublicIndex('test-index.json', {id: 'b', name: 'Bravo'}, 'id')` then `{id: 'a', name: 'Alpha'}` then `{id: 'a', name: 'Alpha Updated'}`.
      2. Read `test-index.json` and assert array = `[{id:'a',name:'Alpha Updated'},{id:'b',name:'Bravo'}]`.
    Expected Result: 2 entries, sorted by id, 'a' has updated name.
    Evidence: `.omo/evidence/task-2-upsert-index.txt`.
  ```

  **Commit**: YES
  - Message: `feat(scripts): add shared blob-seed helper lib`
  - Files: `scripts/lib/blobSeed.mjs`, `package.json`, `package-lock.json` (last two only if `bcryptjs` is newly added)
  - Pre-commit: run the four QA scenarios above and verify all pass.

- [x] 3. scripts/lib/loadTestConsts.mjs: create shared constants used across seed and load-test scripts - single source of truth for fixture identifiers

  **What to do**:
  - Create `scripts/lib/loadTestConsts.mjs` exporting:
    - `ADMIN_EMAIL = "admin@bcc.local"`
    - `FIXTURE_PILOT_PASSWORD = "loadtest-pw-bcc"` (or similar opaque constant — documented as non-secret synthetic).
    - `FIXTURE_PILOT_EMAIL_PATTERN = (n) => "pilot" + String(n).padStart(3, "0") + "@bcc.local"` (yields `pilot001`...`pilot500`).
    - `FIXTURE_CLUB_NAME = (n) => "Club " + String(n).padStart(2, "0")` (yields `Club 01`...`Club 50`).
    - `FIXTURE_TEAM_NAME = (clubN, teamN) => "Club " + ... + " Team " + (teamN === 1 ? "A" : "B")`.
    - `PILOT_COUNT = 500`, `CLUB_COUNT = 50`, `TEAMS_PER_CLUB = 2`, `LOADTEST_TEAMS = 50`, `LOADTEST_SLOTS_PER_TEAM = 10`.
    - `FIXTURE_MANIFEST_PATH = ".fixture-manifest.json"` (at repo root).
    - `PREPARED_ROUND_PATH = "tests/load/.prepared-round.json"`.
    - `DEV_CREDENTIALS_PATH = ".dev-credentials"`.
    - `SEASON_YEAR = new Date().getFullYear()` (computed at module load; or expose `getSeasonYear()` if executor prefers lazy).
    - `TS_CS_VERSION = 1` — DOCUMENTED as mirror of `apps/api/src/lib/termsConstants.ts:1`; add comment to update both if the API constant changes.
    - **`BCC_API_BASE_URL = process.env.BCC_API_BASE_URL ?? "http://localhost:7071"`** — single source of truth for the API endpoint. Local docker mode = default. Azure test-instance mode = set env to `https://your-loadtest-funcapp.azurewebsites.net`.
    - **`IS_AZURE_TARGET = !BCC_API_BASE_URL.startsWith("http://localhost") && !BCC_API_BASE_URL.startsWith("http://127.")`** — convenience flag for scripts that want to gate Azure-specific behavior (e.g., longer timeouts, warm-up phases).
    - **`ADMIN_PASSWORD_OVERRIDE = process.env.ADMIN_PASSWORD ?? null`** — Azure-mode admin credential source. When null, scripts read from `.dev-credentials` (local mode). When set, scripts use this value directly (Azure mode — `.dev-credentials` doesn't exist on the user's laptop pointing at Azure).

  **Must NOT do**:
  - Hardcode the bcrypt hash (compute at runtime via `precomputeBcryptHash`).
  - Import from `apps/api/src/`.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: pure constants file.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T7, T8, T9, T10, T11, T12, T13, T15
  - **Blocked By**: none

  **References**:

  *Pattern References*:
  - `scripts/admin-users.mjs` - constants pattern (top-of-file named exports).

  *API/Type References*:
  - `apps/api/src/lib/termsConstants.ts:1` - `TS_CS_VERSION = 1`. Mirror here; the executor MUST cross-reference and add a comment.

  *WHY Each Reference Matters*:
  - All seed scripts and k6 need a single source of truth for emails, names, counts. Drift between them = broken load test.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: All exported constants importable and well-formed
    Tool: Bash
    Preconditions: scripts/lib/loadTestConsts.mjs created.
    Steps:
      1. Run: `node -e "import('./scripts/lib/loadTestConsts.mjs').then(m => { console.log(m.ADMIN_EMAIL); console.log(m.FIXTURE_PILOT_EMAIL_PATTERN(1), m.FIXTURE_PILOT_EMAIL_PATTERN(500)); console.log(m.PILOT_COUNT, m.CLUB_COUNT, m.TEAMS_PER_CLUB, m.LOADTEST_TEAMS, m.LOADTEST_SLOTS_PER_TEAM); console.log(m.TS_CS_VERSION); })"`
    Expected Result: prints exactly `admin@bcc.local`, `pilot001@bcc.local pilot500@bcc.local`, `500 50 2 50 10`, `1`.
    Evidence: `.omo/evidence/task-3-consts.txt`.

  Scenario: TS_CS_VERSION matches API constant
    Tool: Bash
    Steps:
      1. Run: `node -e "import('./scripts/lib/loadTestConsts.mjs').then(m => console.log(m.TS_CS_VERSION))" > /tmp/sc.txt`
      2. Run: `grep "TS_CS_VERSION" apps/api/src/lib/termsConstants.ts | grep -o '[0-9]\+' > /tmp/api.txt`
      3. Run: `diff /tmp/sc.txt /tmp/api.txt && echo MATCH`
    Expected Result: prints `MATCH`.
    Evidence: `.omo/evidence/task-3-tscs-mirror.txt`.
  Scenario: Azure-target env override works
    Tool: Bash
    Steps:
      1. Run: `BCC_API_BASE_URL=https://example-loadtest.azurewebsites.net node -e "import('./scripts/lib/loadTestConsts.mjs').then(m => { console.log(m.BCC_API_BASE_URL); console.log(m.IS_AZURE_TARGET); })"`
    Expected Result: prints the Azure URL then `true`.
    Evidence: `.omo/evidence/task-3-azure-mode.txt`.

  Scenario: Default (local) mode
    Tool: Bash
    Steps:
      1. Run: `unset BCC_API_BASE_URL && node -e "import('./scripts/lib/loadTestConsts.mjs').then(m => { console.log(m.BCC_API_BASE_URL); console.log(m.IS_AZURE_TARGET); })"`
    Expected Result: prints `http://localhost:7071` then `false`.
    Evidence: `.omo/evidence/task-3-local-mode.txt`.
  ```

  **Commit**: YES
  - Message: `feat(scripts): add shared load-test constants`
  - Files: `scripts/lib/loadTestConsts.mjs`
  - Pre-commit: run the four QA scenarios.

- [x] 4. apps/api/src/lib/puretrack.ts: add PURETRACK_ENABLED short-circuit guard - prevent outbound PureTrack calls in dev/load test

  **What to do**:
  - Read the current `apps/api/src/lib/puretrack.ts` to find all outbound HTTP entry points (e.g., `createPureTrackGroups`, any `fetch` / `axios` calls).
  - Add a top-level guard helper: `const PURETRACK_ENABLED = process.env.PURETRACK_ENABLED !== "false";` (treat any value other than the literal string `"false"` as enabled — fail-open for production safety).
  - At the entry point of EVERY function that makes outbound HTTP, check `if (!PURETRACK_ENABLED) { console.log("[puretrack] skipped: PURETRACK_ENABLED=false"); return /* sensible no-op result */; }`.
  - Return shape must match the success-without-effect path — e.g., `createPureTrackGroups` returns `null` (it already handles `null` ⇒ "skipped" — see `roundsMutate.ts:659`).
  - Add a unit test `apps/api/src/lib/__tests__/puretrackGuard.test.ts` that sets `process.env.PURETRACK_ENABLED = "false"` and asserts the entry points return the no-op shape without making any outbound call (mock `fetch`/`axios` and assert it was NOT called).
  - Update the include list in `apps/api/vitest.config.ts` to add the new test file if needed (see AGENTS.md "include array is partly explicit").

  **Must NOT do**:
  - Disable PureTrack globally — guard only at outbound entry points; reads/config logic remain.
  - Use `PURETRACK_ENABLED === "true"` (would default to disabled on missing env — risk to production).
  - Modify the existing PureTrack unit test mocks in `apps/api/src/__tests__/helpers/setup.ts`.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: small change but security-sensitive (production must still call PureTrack).
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T6
  - **Blocked By**: none

  **References**:

  *Pattern References*:
  - `apps/api/src/lib/puretrack.ts` - module to modify; read entry points first.
  - `apps/api/src/functions/roundsMutate.ts:651-663` - call site for `createPureTrackGroups`; verify `null` return is handled.
  - `apps/api/local.settings.example.json` - look for any `PURETRACK_*` keys to confirm env-var naming style.
  - `apps/api/src/__tests__/helpers/setup.ts` - existing mock of `email`, `pdf`, `puretrack` modules (we're adding runtime guard, NOT replacing mocks).
  - `apps/api/vitest.config.ts` - include array (may need explicit entry per AGENTS.md).

  *API/Type References*:
  - `apps/api/src/functions/roundsMutate.ts:651-663` - the `createPureTrackGroups` call site for return-shape verification.

  *WHY Each Reference Matters*:
  - Fail-open default (`!== "false"`) protects production where the env var might be unset.
  - Existing call site shows `null` is the "skipped" sentinel — guard must return `null` to be a drop-in skip.

  **Acceptance Criteria**:

  - [ ] Test file `apps/api/src/lib/__tests__/puretrackGuard.test.ts` created.
  - [ ] `npx vitest run apps/api/src/lib/__tests__/puretrackGuard.test.ts` → PASS.

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: PURETRACK_ENABLED=false skips outbound calls
    Tool: Bash
    Preconditions: API built; Vitest can run.
    Steps:
      1. Run: `PURETRACK_ENABLED=false npx vitest run apps/api/src/lib/__tests__/puretrackGuard.test.ts`
    Expected Result: test passes; output shows mock fetch was NEVER invoked.
    Failure Indicators: any outbound HTTP attempt; test failures.
    Evidence: `.omo/evidence/task-4-guard-skips.txt` (test stdout).

  Scenario: Unset env defaults to enabled (production safety)
    Tool: Bash
    Steps:
      1. Run: `unset PURETRACK_ENABLED && npx vitest run apps/api/src/lib/__tests__/puretrackGuard.test.ts -t "default"`
    Expected Result: a test case `default behavior calls PureTrack` passes — proves fail-open.
    Evidence: `.omo/evidence/task-4-default-enabled.txt`.

  Scenario: Random non-"false" value still enables PureTrack
    Tool: Bash
    Steps:
      1. Run: `PURETRACK_ENABLED=disabled npx vitest run apps/api/src/lib/__tests__/puretrackGuard.test.ts -t "string"`
    Expected Result: test confirms only the literal `"false"` disables; `"disabled"`, `""`, `"0"`, etc., all enable.
    Evidence: `.omo/evidence/task-4-strict-string.txt`.
  ```

  **Commit**: YES
  - Message: `feat(api): add PURETRACK_ENABLED guard to puretrack module`
  - Files: `apps/api/src/lib/puretrack.ts`, `apps/api/src/lib/__tests__/puretrackGuard.test.ts`, `apps/api/vitest.config.ts` (if include updated)
  - Pre-commit: `npx vitest run apps/api/src/lib/__tests__/puretrackGuard.test.ts && make typecheck`.

- [x] 5. apps/api/src/lib/rateLimit.ts + roundRegistration.ts: rate-limit identityKey for per-pilot register-self budgets - fix shared-NAT bug AND eliminate need for any test-only bypass

  **What to do**:

  Part A — `apps/api/src/lib/rateLimit.ts`:
  - Extend `RateLimitOpts` interface (line 78):
    ```ts
    export interface RateLimitOpts {
      endpoint: string;
      capacity: number;
      refillPerMin: number;
      /** When provided, used as the bucket key instead of the request IP.
       *  Use for authenticated endpoints where per-identity limiting is desired
       *  (e.g., register-self uses caller.pilotId). When absent, falls back to IP.
       *  See file header: "paragliding meets share NAT". */
      identityKey?: string;
    }
    ```
  - In `rateLimit(req, opts)` (line 93), change the key construction (line 99) ONLY:
    ```ts
    const ip = /* existing resolution unchanged */;
    const keyPart = opts.identityKey ?? ip;
    const key = `${keyPart}:${opts.endpoint}`;
    ```
  - All other lines unchanged. Backwards-compatible for the 7 IP-keyed callers.

  Part B — `apps/api/src/functions/roundRegistration.ts`:
  - At both rate-limit call sites (lines 38 and 85):
    - Ensure `caller = await getCallerIdentity(req)` is resolved BEFORE the rate-limit call (verify current ordering; move if needed — the auth check should already be early).
    - Change:
      ```ts
      rateLimit(req, { endpoint: "round-register", capacity: 10, refillPerMin: 10 });
      ```
      to:
      ```ts
      // Fail-safe: pilotId for the authenticated happy path; "anon:" + IP for the
      // (defensive) edge case where caller exists but pilotId is null. The handler
      // 403s anonymous callers before this point, so caller is always defined here.
      const ipFallback = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
                       ?? req.headers.get("x-azure-clientip") ?? "unknown";
      const identityKey = caller.pilotId ?? `anon:${ipFallback}`;
      rateLimit(req, { endpoint: "round-register", capacity: 10, refillPerMin: 10, identityKey });
      ```

  Part C — tests:
  - Extend `apps/api/src/lib/__tests__/rateLimit.test.ts` with a new test inside the existing `describe("rateLimit")` block:
    ```ts
    test("identityKey isolates buckets between two identities on same IP", () => {
      resetAllBuckets();
      const req = makeReq("10.0.0.5");
      const opts = { endpoint: "round-register", capacity: 1, refillPerMin: 0, identityKey: "pilot-a" };
      const optsB = { ...opts, identityKey: "pilot-b" };
      rateLimit(req, opts);      // pilot-a uses their bucket
      rateLimit(req, optsB);     // pilot-b's bucket is independent — should succeed
      expect(() => rateLimit(req, opts)).toThrow();   // pilot-a now exhausted
      expect(() => rateLimit(req, optsB)).toThrow();  // pilot-b also now exhausted
    });
    test("absent identityKey preserves IP-keyed behavior (regression check)", () => {
      resetAllBuckets();
      const opts = { endpoint: "round-register", capacity: 1, refillPerMin: 0 };
      rateLimit(makeReq("10.0.0.6"), opts);
      expect(() => rateLimit(makeReq("10.0.0.6"), opts)).toThrow();
      expect(() => rateLimit(makeReq("10.0.0.7"), opts)).not.toThrow();
    });
    ```
  - Extend `apps/api/src/functions/__tests__/roundRegistration.test.ts` with at least one integration-style test: register two different fixture pilots from the same simulated IP back-to-back; both must succeed (no 429 between them). Confirms the call-site change actually keys on `caller.pilotId`.

  **Must NOT do**:
  - Change rate-limit key strategy for any of the other 7 endpoints (`register`, `login`, `verify-email`, `resend-verification`, `forgot-password`, `reset-password`, `refresh`) — they MUST remain IP-keyed (they're anonymous/token-bearing; identity not stable enough to use as key).
  - Introduce ANY env-var-gated bypass (this whole task exists to make bypass unnecessary).
  - Change the `rateLimit()` function signature (additive optional field only).
  - Remove or modify the existing IP-resolution code in `rateLimit.ts`.
  - Use `caller.userId` instead of `caller.pilotId` (pilotId is the right unit for register-self; multiple users could theoretically share a pilotId via admin auto-link, and the rate limit applies to the registration action which is per-pilot).
  - Bypass IP fallback entirely — if `caller.pilotId` is somehow undefined the code MUST fall back to `anon:${ip}` to preserve protection.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: small change but security-relevant; preserves backwards-compat for 7 callers; extends tests in two locations.
  - **Skills**: none
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T2, T3, T4)
  - **Blocks**: T15 (k6 register-phase relies on identity-keyed limit being live)
  - **Blocked By**: none

  **References**:

  *Pattern References*:
  - `apps/api/src/lib/rateLimit.ts:9` - file header comment "Lockout by IP is intentionally omitted — paragliding meets share NAT" — this task generalizes that domain insight to the rate limiter.
  - `apps/api/src/lib/rateLimit.ts:93-115` - `rateLimit()` body; the only edit site (one new line + new optional field).
  - `apps/api/src/functions/roundRegistration.ts:38,85` - the two call sites that must pass `identityKey`.
  - `apps/api/src/lib/__tests__/rateLimit.test.ts:54-110` - existing test structure with `makeReq("10.0.0.x")` helper; the new tests extend the same `describe` block.
  - `apps/api/src/functions/__tests__/roundRegistration.test.ts` - existing integration test file; extend with the two-pilots-one-IP scenario.

  *API/Type References*:
  - `apps/api/src/lib/auth.ts` `getCallerIdentity()` - returns `CallerIdentity | null`; `pilotId` is on the `Pilot`-role identity.

  *Other Callers (verify untouched)*:
  - `apps/api/src/functions/authFunctions.ts:154,231,272,334,401,436,487` - 7 call sites that MUST remain unchanged.

  *WHY Each Reference Matters*:
  - The file header on line 9 already names "paragliding meets share NAT" as the design driver; this task makes the rate limiter consistent with that stated principle.
  - Verifying the 7 other call sites stay unchanged prevents regressions in anonymous-endpoint protection (where IP keying is correct).

  **Acceptance Criteria**:

  - [ ] `RateLimitOpts.identityKey?: string` exists; TypeScript compiles across the workspace (`make typecheck` passes).
  - [ ] `roundRegistration.ts` passes `identityKey: caller.pilotId ?? "anon:..." ` at both call sites.
  - [ ] The 7 other rate-limit call sites in `authFunctions.ts` are byte-identical to before (verified via `git diff -- apps/api/src/functions/authFunctions.ts` showing zero rate-limit-related changes).
  - [ ] `npx vitest run apps/api/src/lib/__tests__/rateLimit.test.ts` passes including the 2 new tests.
  - [ ] `npx vitest run apps/api/src/functions/__tests__/roundRegistration.test.ts` passes including the new "two pilots one IP" scenario.

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Two pilots from same IP get their own buckets (the headline win)
    Tool: Bash
    Preconditions: API code patched, build artifacts up to date.
    Steps:
      1. Run: `npx vitest run apps/api/src/lib/__tests__/rateLimit.test.ts -t "identityKey isolates"`
    Expected Result: test passes; output proves bucket isolation by identityKey.
    Failure Indicators: test fails OR the new test isn't picked up (check vitest config include).
    Evidence: `.omo/evidence/task-5-identity-isolation.txt` (test stdout).

  Scenario: Backwards compatibility for IP-keyed callers
    Tool: Bash
    Steps:
      1. Run: `npx vitest run apps/api/src/lib/__tests__/rateLimit.test.ts`
    Expected Result: ALL existing tests still pass; total test count ≥ previous + 2.
    Evidence: `.omo/evidence/task-5-backcompat.txt` (test stdout).

  Scenario: Other 7 endpoints' rate-limit call sites unchanged (regression grep)
    Tool: Bash
    Steps:
      1. Run: `git diff -U0 apps/api/src/functions/authFunctions.ts | grep -E "^[+-].*rateLimit\(req" | grep -v "^---\\|^\\+\\+\\+"`
    Expected Result: zero output (no `rateLimit(req, ...)` lines added or removed in that file).
    Evidence: `.omo/evidence/task-5-authfns-untouched.txt`.

  Scenario: Real-stack — two real pilots from one source IP both succeed back-to-back
    Tool: Bash
    Preconditions: docker stack up with patched API + fixtures seeded (after T7 + T8 land in Wave 2; this scenario runs late but verifies the runtime).
    Steps:
      1. Login as pilot001 → grab JWT_A.
      2. Login as pilot002 → grab JWT_B.
      3. Pick any Confirmed round.
      4. `for i in 1..15; do  curl POST /api/rounds/{id}/register-self  alternating JWT_A and JWT_B; done`
      5. Assert: zero 429 responses (each pilot has own 10/min budget, well within limit).
    Expected Result: 15 successful (or business-logic-rejected: SLOT_TAKEN/etc — but NOT 429) responses.
    Failure Indicators: any HTTP 429.
    Evidence: `.omo/evidence/task-5-real-stack.txt` (curl status codes).

  Scenario: Confirms no env-var bypass leaked into the codebase
    Tool: Bash
    Steps:
      1. Run: `grep -rn "ALLOW_TEST_RATE_LIMIT_BYPASS\|WEBSITE_INSTANCE_ID.*bypass\|rate.?limit.?bypass" apps/api/src scripts && echo FAIL || echo PASS`
    Expected Result: prints `PASS` (no such names anywhere in source).
    Evidence: `.omo/evidence/task-5-no-bypass-grep.txt`.
  ```

  **Commit**: YES
  - Message: `feat(api): rate-limit identityKey for per-pilot register-self budgets`
  - Files: `apps/api/src/lib/rateLimit.ts`, `apps/api/src/functions/roundRegistration.ts`, `apps/api/src/lib/__tests__/rateLimit.test.ts`, `apps/api/src/functions/__tests__/roundRegistration.test.ts`
  - Pre-commit: all five QA scenarios (Scenario 4 may run later in Wave 3 — the rest must pass before commit) + `make typecheck`.

- [x] 6. docker-compose.yml: add PURETRACK_ENABLED=false to api service env - wire compose stack to honor the PureTrack guard added in T4

  **What to do**:
  - Edit `docker-compose.yml` `api` service `environment:` block:
    - Add `PURETRACK_ENABLED: "false"`.
  - Do NOT add the var to any other service (web, azurite, azurite-init).
  - Keep all existing env keys unchanged.

  **Must NOT do**:
  - Add `ALLOW_TEST_RATE_LIMIT_BYPASS` or any other rate-limit bypass env var. The identity-keyed rate limit from T5 removes the need.
  - Touch the `web`, `azurite`, or `azurite-init` services.
  - Reformat or reorder unrelated YAML.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 1-line YAML edit.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on T4 landing so the env var is recognized)
  - **Parallel Group**: Wave 2 (with T7, T8, T10, T12)
  - **Blocks**: T14
  - **Blocked By**: T4

  **References**:

  *Pattern References*:
  - `docker-compose.yml` `api` service `environment:` block - mimic existing key style (uppercase env, string values quoted).

  *WHY Each Reference Matters*:
  - Existing block has `JWT_SECRET`, `BLOB_CONNECTION_STRING`, etc. Match indentation and quoting exactly.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: PURETRACK_ENABLED=false present in api container at runtime
    Tool: Bash
    Preconditions: T4 + T6 applied; docker compose ready.
    Steps:
      1. Run: `docker compose down -v && docker compose up -d --build api`
      2. Wait 30s for api health.
      3. Run: `docker compose exec api printenv PURETRACK_ENABLED`
    Expected Result: prints `false`.
    Evidence: `.omo/evidence/task-6-env-present.txt`.

  Scenario: No bypass env var present
    Tool: Bash
    Steps:
      1. Run: `docker compose exec api printenv | grep -i "rate.?limit.?bypass\|ALLOW_TEST" && echo FAIL || echo PASS`
    Expected Result: prints `PASS` (no such env vars).
    Evidence: `.omo/evidence/task-6-no-bypass.txt`.

  Scenario: Web service env unaffected
    Tool: Bash
    Steps:
      1. Run: `docker compose exec web printenv | grep -E "PURETRACK_ENABLED" && echo FAIL || echo PASS`
    Expected Result: prints `PASS`.
    Evidence: `.omo/evidence/task-6-web-clean.txt`.
  ```

  **Commit**: YES
  - Message: `chore(compose): set PURETRACK_ENABLED=false for api`
  - Files: `docker-compose.yml`
  - Pre-commit: run the three QA scenarios.

- [x] 7. scripts/seed-admin.mjs: idempotent admin bootstrap (used by api-init service) - create admin@bcc.local with random pw, skip if exists

  **What to do**:
  - Create `scripts/seed-admin.mjs` (ESM, Node).
  - Imports: `getPrivateContainer`, `readJson`, `writeJson`, `precomputeBcryptHash`, `deterministicUuid` from `./lib/blobSeed.mjs`; `ADMIN_EMAIL`, `DEV_CREDENTIALS_PATH`, `TS_CS_VERSION` from `./lib/loadTestConsts.mjs`; `randomBytes` from `node:crypto`; `writeFileSync`, `chmodSync` from `node:fs`.
  - Algorithm:
    1. Read `user-index.json` from `data-private`.
    2. If `index[ADMIN_EMAIL]` exists: log to STDERR `"=== BCC ADMIN: admin@bcc.local already exists. Run 'docker compose down -v' to regenerate. ==="` in ANSI yellow (`\x1b[33m...\x1b[0m`) and exit 0.
    3. Else:
       a. Generate random 16-char alphanumeric password: `randomBytes(12).toString('base64url').slice(0, 16)`.
       b. Compute `userId = deterministicUuid("admin-user", ADMIN_EMAIL)`.
       c. Compute `passwordHash = await precomputeBcryptHash(password)`.
       d. Write `auth/{userId}.json` = `{ passwordHash, emailVerified: true, createdAt: new Date().toISOString() }`.
       e. Write `users/{userId}.json` = `{ id: userId, email: ADMIN_EMAIL, roles: ["Admin"], createdAt: ..., acceptedTsCsVersion: TS_CS_VERSION }`.
       f. Read `user-index.json` (refresh, in case of race), set `index[ADMIN_EMAIL] = userId`, write back.
       g. Print to STDERR with ANSI yellow + bell+bold the line: `"=== BCC ADMIN PASSWORD: " + password + " (email: admin@bcc.local) ==="`. Repeat three times for visibility.
       h. Write `DEV_CREDENTIALS_PATH` (`.dev-credentials`) with content `ADMIN_EMAIL=admin@bcc.local\nADMIN_PASSWORD=<password>\n`, chmod 600.
  - Exit 0 on success; exit 1 on error with clear stderr message.

  **Must NOT do**:
  - Hardcode the password.
  - Write the password to any blob (Azurite or otherwise).
  - Print to STDOUT (must be STDERR — see Metis: unbuffered, more visible above noise).
  - Update `pilot-email-index.json` (admin is not a pilot).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: small but security-sensitive idempotency logic.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES (with rest of Wave 2)
  - **Parallel Group**: Wave 2 (with T6, T8, T10, T12)
  - **Blocks**: T14
  - **Blocked By**: T2, T3

  **References**:

  *Pattern References*:
  - `scripts/admin-users.mjs` - established `.mjs` style + `BLOB_CONNECTION_STRING` env handling.
  - `apps/api/src/lib/auth.ts` `getOrCreateUser()` - reference for `User` shape and `user-index.json` update pattern.
  - `apps/api/src/functions/authFunctions.ts:374` - confirms `emailVerified: true` required.

  *API/Type References*:
  - `packages/types/src/index.ts` - `User` type definition.

  *WHY Each Reference Matters*:
  - Admin must have `Admin` role on creation — `getOrCreateUser` defaults to `[]` or `["Pilot"]`, so we bypass that and create directly.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Cold run creates admin and prints password
    Tool: Bash
    Preconditions: Azurite running, no admin user exists (`docker compose down -v` first).
    Steps:
      1. Run: `docker compose up -d azurite azurite-init && sleep 5`
      2. Run: `BLOB_CONNECTION_STRING="<azurite>" node scripts/seed-admin.mjs 2>/tmp/se.err`
      3. Capture: `cat /tmp/se.err | grep "BCC ADMIN PASSWORD"`
      4. Capture: `cat .dev-credentials`
    Expected Result: stderr has 3 lines containing `BCC ADMIN PASSWORD: <16chars>`; `.dev-credentials` has matching `ADMIN_PASSWORD=<same16chars>`.
    Evidence: `.omo/evidence/task-7-cold-run.txt`.

  Scenario: Login succeeds with printed password
    Tool: Bash
    Steps:
      1. Get password: `PW=$(awk -F= '/ADMIN_PASSWORD/{print $2}' .dev-credentials)`
      2. Start API: `make dev-api &` (or `docker compose up -d api`); wait healthy.
      3. Run: `curl -s -X POST http://localhost:7071/api/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"admin@bcc.local\",\"password\":\"$PW\"}" | jq .`
    Expected Result: response has `accessToken` (non-null string); subsequent `curl /api/me` with that token shows `roles: ["Admin"]`.
    Evidence: `.omo/evidence/task-7-login.txt`.

  Scenario: Idempotent re-run does not regenerate password
    Tool: Bash
    Steps:
      1. With Azurite already containing the admin (from previous scenario), run: `node scripts/seed-admin.mjs 2>/tmp/se2.err`
      2. Verify: `cat /tmp/se2.err | grep "already exists"`
      3. Verify exit code 0.
    Expected Result: stderr contains "already exists"; exit 0; `.dev-credentials` unchanged.
    Evidence: `.omo/evidence/task-7-idempotent.txt`.

  Scenario: Password file permissions are 600
    Tool: Bash
    Steps:
      1. Run: `stat -f '%A' .dev-credentials` (macOS) or `stat -c '%a' .dev-credentials` (Linux)
    Expected Result: prints `600`.
    Evidence: `.omo/evidence/task-7-perms.txt`.
  ```

  **Commit**: YES
  - Message: `feat(scripts): idempotent admin bootstrap for docker compose`
  - Files: `scripts/seed-admin.mjs`
  - Pre-commit: all four QA scenarios + verify no password leaks to stdout (`node scripts/seed-admin.mjs 2>/dev/null` produces empty stdout).

- [x] 8. scripts/seed-fixtures.mjs: bulk fixture generator (500 pilots + 50 clubs + 100 teams + season + sites + config) - reach SPA-renderable state in one command

  **What to do**:
  - Create `scripts/seed-fixtures.mjs` (ESM, Node).
  - Imports: all blobSeed helpers; all loadTestConsts.
  - Algorithm (in order):
    1. Compute ONE shared `pilotPasswordHash = await precomputeBcryptHash(FIXTURE_PILOT_PASSWORD)` — exactly one bcrypt call.
    2. Build the in-memory manifest object `{seasonYear, siteIds, clubIds, teamIds, pilotIds, userIds}`.
    3. **Sites**: create 3 sites (`Site Alpha`, `Site Bravo`, `Site Charlie`). For each: `siteId = deterministicUuid("fixture-site", name)`. Write `sites/{id}.json` with minimal valid `Site` shape (look up `Site` type in `packages/types/src/index.ts` and seed required fields only).
    4. **Season**: `seasonYear = SEASON_YEAR`. Write public `seasons/{year}.json` with `{ year, name: "BCC " + year, startDate: year+"-04-01", endDate: year+"-10-31", active: true, rounds: [] }`. Update `seasons.json` (array) to include this season; mark active.
    5. **Config**: read existing `data-private/config.json` (or default), patch `{ maxTeamsInClub: 3, maxPilotsInTeam: 10, maxScoringPilotsInTeam: 5, flightDateValidationEnabled: false }`, preserve `wingFactors` if present (else write defaults `{ "EN A": 1.2, "EN B": 1.1, "EN C": 1.0, "EN D": 0.9 }`). Write back.
    6. **Clubs (50)**: for n in 1..50:
       - `clubId = deterministicUuid("fixture-club", "club" + n)`
       - `name = FIXTURE_CLUB_NAME(n)` (`"Club 01"`...`"Club 50"`)
       - Write `clubs/{id}.json` private = `{ id, name, sites: [first siteId], teams: [], createdAt, updatedAt }`
       - Push `{ id, name }` into the to-write `clubs.json` array.
    7. **Club teams (100 = 50 clubs × 2 teams)**: for each club, for teamN in 1..2:
       - `teamId = deterministicUuid("fixture-club-team", clubId + "-" + teamN)`
       - `teamName = FIXTURE_TEAM_NAME(n, teamN)`
       - Write `club-teams/{id}.json` private = `{ id, clubId, clubName, seasonYear, teamName, createdAt }`
       - Push minimal summary to `club-teams.json` array.
    8. **Pilots (500)**: for n in 1..500:
       - `email = FIXTURE_PILOT_EMAIL_PATTERN(n)`
       - `pilotId = deterministicUuid("fixture-pilot", email)`
       - `userId = deterministicUuid("fixture-user", email)`
       - `firstName = "Pilot"`, `lastName = "P" + String(n).padStart(3,"0")`, `fullName = firstName + " " + lastName`
       - **Pilot blob** (`pilots/{pilotId}.json` private): minimal `Pilot` shape per Oracle phase-1 findings — `{ id: pilotId, coachType: "None", pilotRating: "Pilot", person: { id: pilotId, firstName, lastName, fullName }, seasonClubs: [{ seasonYear, clubId: <assigned club, round-robin: n % 50 + 1>, clubTeamId: null }], userId, profileUpdatedAt: new Date().toISOString() }`.
         - `profileUpdatedAt` set to current year so `FirstLoginOfSeasonGate` doesn't treat it as new pilot.
       - **Auth blob** (`auth/{userId}.json` private): `{ passwordHash: pilotPasswordHash, emailVerified: true, createdAt: now }`.
       - **User blob** (`users/{userId}.json` private): `{ id: userId, email, roles: ["Pilot"], pilotId, clubId, createdAt, acceptedTsCsVersion: TS_CS_VERSION }`.
       - Push to `pilots.json` public summary: `{ id: pilotId, name: fullName, clubId, rating: "Pilot" }` (NO email, NO bhpaNumber).
    9. **Indexes**: write `user-index.json` (all 500 + any pre-existing entries merged), `pilot-email-index.json` (all 500 + pre-existing).
    10. **Public index blobs**: write `pilots.json`, `clubs.json`, `club-teams.json`, `seasons.json`, `seasons/{year}.json` in `data` container.
    11. **Manifest**: write `FIXTURE_MANIFEST_PATH` (`.fixture-manifest.json`) containing all generated IDs (used by `wipe-fixtures.mjs`).
    12. Print summary to STDERR: `"[seed-fixtures] OK: 500 pilots / 50 clubs / 100 teams / 3 sites / season N"`.
  - **PERFORMANCE**: bcrypt called exactly once. All blob writes parallelized via `Promise.all` in chunks of 50 to avoid file-handle exhaustion. Target: <90 seconds.
  - **WIPE FIRST**: at start of script (after computing IDs but before writing), check if manifest exists; if yes, invoke `scripts/wipe-fixtures.mjs` logic inline (or import it as a function) to delete known IDs.

  **Must NOT do**:
  - Call `bcrypt.hash()` more than once.
  - Make any HTTP API calls.
  - Wipe non-fixture blobs (must be surgical by manifest).
  - Include PII in `pilots.json` public summary.
  - Forget to set `acceptedTsCsVersion: TS_CS_VERSION` on user blobs.
  - Forget to set `emailVerified: true` on auth blobs.
  - Write `config.json` without preserving existing `wingFactors`.

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: largest single deliverable; many side effects to coordinate; PII compliance critical.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES (after T2 + T3)
  - **Parallel Group**: Wave 2 (with T6, T7, T10, T12)
  - **Blocks**: T9, T11, T16
  - **Blocked By**: T2, T3

  **References**:

  *Pattern References*:
  - `apps/api/src/__tests__/helpers/seed.ts:85+` — shape templates for `makeUser`, `makePilot`, `makeClub`, `makeClubTeam`, `makeSite`. REPLICATE the field selection, do not import.
  - `apps/api/src/functions/pilots.ts:298` `upsertPilotInIndex()` — confirms PilotSummary field selection; callsite at `pilots.ts:189` shows when it fires after a private write.
  - `apps/api/src/functions/clubs.ts:124` `upsertClubInIndex()` — ClubSummary upsert pattern.
  - `apps/api/src/functions/clubTeams.ts:261` `upsertTeamInIndex()` — ClubTeamSummary upsert pattern.
  - `apps/api/src/lib/auth.ts:36` `getOrCreateUser()` — User blob shape (`{id, email, roles[], pilotId?, clubId?, createdAt, acceptedTsCsVersion?}`).
  - `apps/api/src/functions/roundRegistration.ts:182-194` — `config.json` defaults (use these for unspecified fields).
  - `scripts/init-storage.mjs` — container connection pattern.

  *API/Type References*:
  - `packages/types/src/index.ts` - `Pilot`, `Club`, `ClubTeam`, `Site`, `Season`, `User`, `PilotSummary`, `ClubSummary`, `ClubTeamSummary`.

  *Test References*:
  - `apps/api/src/__tests__/pilot-autolink.test.ts` - confirms `pilot-email-index.json` shape `{ email: pilotId }`.
  - `apps/api/src/__tests__/blob-split-security.test.ts` - confirms public/private split.

  *External References*:
  - `node scripts/privacy-scan.mjs` will be run post-seed; design the public summaries with this scanner in mind.

  *WHY Each Reference Matters*:
  - `upsert*` helpers in API have the EXACT field selection that the SPA expects. Drift breaks pages silently.
  - `pilot-email-index.json` enables auto-link in `getOrCreateUser`; we pre-seed both sides (user + pilot + index) so this autolink is a no-op for fixture pilots.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Counts match exactly
    Tool: Bash
    Preconditions: Azurite running, admin seeded (T7 done).
    Steps:
      1. Run: `time node scripts/seed-fixtures.mjs`
      2. Verify: `curl -s http://localhost:3000/blob/pilots.json | jq 'length'` → 500
      3. Verify: `curl -s http://localhost:3000/blob/clubs.json | jq 'length'` → 50
      4. Verify: `curl -s http://localhost:3000/blob/club-teams.json | jq 'length'` → 100
      5. Verify: `curl -s http://localhost:3000/blob/seasons.json | jq 'length'` → 1
      6. Verify: time elapsed < 90 seconds.
    Expected Result: all 4 counts exact, time under 90s.
    Evidence: `.omo/evidence/task-8-counts.txt`.

  Scenario: Pilot 1 and Pilot 500 can both log in
    Tool: Bash
    Steps:
      1. For both `pilot001@bcc.local` and `pilot500@bcc.local`: `curl -X POST /api/auth/login -d ...`
      2. Assert both return HTTP 200 with accessToken.
      3. `curl /api/me` with each token → roles=["Pilot"], pilotId non-null.
    Expected Result: both succeed; `pilotId` matches deterministic UUID for that email.
    Evidence: `.omo/evidence/task-8-login-both.txt`.

  Scenario: Privacy scan passes
    Tool: Bash
    Steps:
      1. Run: `node scripts/privacy-scan.mjs`
    Expected Result: exit 0.
    Evidence: `.omo/evidence/task-8-privacy.txt`.

  Scenario: T&Cs gate does NOT trigger for fixture pilots
    Tool: Bash
    Steps:
      1. Login as pilot001, fetch /api/me.
      2. Assert response `tsCsAcceptanceRequired: false` and `firstLoginOfSeason: false`.
    Expected Result: both false (gate would block login flow otherwise).
    Evidence: `.omo/evidence/task-8-tcs-ok.txt`.

  Scenario: config.json has maxPilotsInTeam = 10
    Tool: Bash
    Steps:
      1. Read `config.json` from private container via node one-liner using blobSeed.
      2. Assert `maxPilotsInTeam === 10`.
    Expected Result: 10.
    Evidence: `.omo/evidence/task-8-config.txt`.

  Scenario: Re-run is wipe-and-reseed (idempotent count, fresh data)
    Tool: Bash
    Steps:
      1. Run `node scripts/seed-fixtures.mjs` a second time.
      2. Re-verify counts (500/50/100).
      3. Verify pilot001 still logs in with same password.
    Expected Result: same counts, login still works.
    Evidence: `.omo/evidence/task-8-rerun.txt`.

  Scenario: Manifest written with all known IDs
    Tool: Bash
    Steps:
      1. Run: `jq '.pilotIds | length' .fixture-manifest.json`
    Expected Result: 500.
    Evidence: `.omo/evidence/task-8-manifest.txt`.
  ```

  **Commit**: YES
  - Message: `feat(scripts): bulk fixture generator for pilots/clubs/teams/season/sites/config`
  - Files: `scripts/seed-fixtures.mjs`
  - Pre-commit: all seven QA scenarios pass.

- [x] 9. scripts/seed-rounds.mjs: seed 4 rounds in varied statuses via the production API - rounds list page renders without manual creation; brief auto-creates on confirm (no direct Blob SDK brief writes)

  **What to do**:
  - Create `scripts/seed-rounds.mjs` (ESM, Node).
  - Imports: loadTestConsts (including `BCC_API_BASE_URL`, `IS_AZURE_TARGET`, `ADMIN_PASSWORD_OVERRIDE`) + `readFileSync, writeFileSync` from `node:fs` + `fetch` (Node 20 global). **NO blobSeed import — this script is now pure HTTP, like T11.**
  - Preconditions:
    - Read `FIXTURE_MANIFEST_PATH`; if missing, exit 1 with `"Run 'make seed' first (target: ${BCC_API_BASE_URL})"`.
    - Admin credential resolution: `ADMIN_PASSWORD_OVERRIDE` env (Azure mode) → else `DEV_CREDENTIALS_PATH` (local mode) → else exit 1.
  - Algorithm:
    1. Login as admin → JWT.
    2. For each of 4 target statuses in order — `["Proposed", "Confirmed", "BriefComplete", "Locked"]` — drive the round through the full lifecycle via the API:
       a. `POST ${BCC_API_BASE_URL}/api/rounds` body `{ date: <today + offset days; offset varies per status>, siteId: manifest.siteIds[0], seasonYear: manifest.seasonYear }`. Capture `roundId`. Round is now `Proposed`.
       b. Add 4 teams: for each of the first 4 fixture clubs, `POST ${BCC_API_BASE_URL}/api/rounds/{roundId}/teams` body `{ clubId, teamName }`. Capture `teamId` for each.
       c. Add 3 pilots per team: for each team, for place 1..3, `POST ${BCC_API_BASE_URL}/api/rounds/{roundId}/teams/{teamId}/pilots` body `{ pilotId: manifest.pilotIds[N], isScoring: place === 1 }`. (Use deterministic pilot indexing so re-runs are stable.)
       d. If target status is at least `Confirmed`: `POST ${BCC_API_BASE_URL}/api/rounds/{roundId}/confirm` (empty body). This triggers the brief-lifecycle-fix's auto-brief-creation at `roundsMutate.ts:397-400`.
       e. If target status is at least `BriefComplete`: `POST ${BCC_API_BASE_URL}/api/rounds/{roundId}/brief-complete`.
       f. If target status is `Locked`: `POST ${BCC_API_BASE_URL}/api/rounds/{roundId}/lock`. Note: PDF generation runs inside `lockRound` but is caught internally (`apps/api/src/functions/roundsMutate.ts:724-733`); the round status transitions to `Locked` even if chromium is missing or PDF gen fails. Script does NOT need try/catch around this call — it always returns 2xx.
    3. Append the 4 roundIds to `.fixture-manifest.json` under `.roundIds`.
    4. Print summary to STDERR: `"[seed-rounds] OK: target=${BCC_API_BASE_URL} 4 rounds (Proposed/Confirmed/BriefComplete/Locked)"`.

  **Must NOT do**:
  - Hardcode `http://localhost:7071` — always use `BCC_API_BASE_URL`.
  - Write `rounds/{id}.json` or `round-briefs/{id}.json` directly via Blob SDK. The API now owns the full lifecycle including brief creation (per the brief-lifecycle-fix plan). Direct writes would bypass `buildRoundBrief()` derivation, skip public-index updates the API performs, and re-introduce the architectural smell the brief-lifecycle-fix plan removed.
  - Import `@azure/storage-blob` or `scripts/lib/blobSeed.mjs`. Pure HTTP only.
  - Update `rounds.json`, `seasons/{year}.json`, or any public denormalization index directly. The API's handlers maintain these.
  - Add scoring/flight data (rounds are dev-browsing shells, not scoring fixtures).
  - Touch any fixture pilots/clubs/teams (read-only from manifest).
  - Wrap the `POST /lock` call in try/catch — lockRound catches its own PDF failure internally; the HTTP call always succeeds for valid input.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: data assembly with status-dependent branching; brief blob requirement is critical.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES (with rest of Wave 2)
  - **Parallel Group**: Wave 3 (with T11, T14)
  - **Blocks**: T16
  - **Blocked By**: T3, T8

  **References**:

  *Pattern References*:
  - `apps/api/src/functions/roundsMutate.ts:94-180` — `createRound` body shape and lifecycle entry point.
  - `apps/api/src/functions/roundsMutate.ts:397-400` — `confirmRound`'s auto-brief-creation block (the reason this script no longer writes briefs directly).
  - `apps/api/src/functions/roundsMutate.ts:670-700` — `lockRound` flow; PDF generation failures are caught INTERNALLY at lines 724-733 and do NOT fail the HTTP call (the round still transitions to `Locked`). This is why `seed-rounds.mjs` does NOT need a script-level try/catch around `/lock`.
  - `apps/api/src/functions/teams.ts` — add-team / add-pilot-to-team endpoint shapes (verify paths).
  - `scripts/prepare-loadtest.mjs` (T11) — sibling script that follows the same pure-HTTP, env-aware pattern; mirror its structure.

  *API/Type References*:
  - `packages/types/src/index.ts` — `Round`, `Team`, `TeamSlot` types (read-only; this script never constructs them — the API does).
  - `apps/api/src/functions/signatures.ts:71-75` — confirms brief is REQUIRED for sign endpoint (validates the BriefComplete round's brief blob really did get created by confirmRound).

  *WHY Each Reference Matters*:
  - `roundsMutate.ts:397-400` is the line range that makes this script's API-only approach work — without the brief-lifecycle fix, this script would have to write the brief blob directly. Cite it so the executor understands the dependency.
  - The `lockRound` lifecycle includes PDF generation; failures there are caught inside `lockRound` (`roundsMutate.ts:724-733`) and do NOT fail the HTTP call. `seed-rounds.mjs` should therefore NOT implement a script-level fallback — it should assert that all 4 rounds reach their target status (including Locked), and observe API warning logs for any PDF-gen issues.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 4 rounds visible in public rounds.json (via API, no direct Blob SDK)
    Tool: Bash
    Preconditions: T8 (seed-fixtures) ran first; api running on `${BCC_API_BASE_URL}`; PURETRACK_ENABLED=false on the target.
    Steps:
      1. Run: `node scripts/seed-rounds.mjs`
      2. Verify (LOCAL): `curl -s http://localhost:3000/blob/rounds.json | jq 'map(.status) | sort | unique'`
         Verify (AZURE): `curl -s ${BCC_API_BASE_URL}/api/rounds | jq 'map(.status) | sort | unique'`
    Expected Result: status set equals `["BriefComplete","Confirmed","Locked","Proposed"]`. All 4 rounds reach their target status (lockRound's internal PDF-failure catch means `/lock` always succeeds at the HTTP level for valid input).
    Evidence: `.omo/evidence/task-9-statuses.txt`.

  Scenario: BriefComplete round has a brief blob (auto-created by confirmRound)
    Tool: Bash
    Steps:
      1. Identify the BriefComplete roundId from manifest (`jq '.roundIds[2]' .fixture-manifest.json`) or by status scan.
      2. Login as admin → JWT; `curl ${BCC_API_BASE_URL}/api/rounds/{roundId}/brief` with the JWT.
      3. Assert HTTP 200; response body parses as JSON with populated `siteName`, `date`, `teams[]`; narrative fields undefined.
    Expected Result: 200 + derived brief; narrative absent.
    Evidence: `.omo/evidence/task-9-brief-blob.txt`.

  Scenario: Signing the BriefComplete round works (proves the auto-created brief is real and signable)
    Tool: Bash
    Steps:
      1. Pick a filled slot in the BriefComplete round (any team, place 1..3).
      2. Login as the assigned pilot.
      3. `curl POST ${BCC_API_BASE_URL}/api/rounds/{roundId}/teams/{teamId}/pilots/{place}/sign` with the pilot JWT.
    Expected Result: HTTP 200; subsequent `GET /api/rounds/{roundId}` shows the slot has `signToFly === true`.
    Evidence: `.omo/evidence/task-9-sign-sanity.txt`.

  Scenario: Script never imports Blob SDK (regression check)
    Tool: Bash
    Steps:
      1. Run: `grep -nE "from ['\\"]\\.?\\.?/lib/blobSeed|@azure/storage-blob" scripts/seed-rounds.mjs && echo FAIL || echo PASS`
    Expected Result: prints `PASS`.
    Evidence: `.omo/evidence/task-9-pure-http.txt`.

  Scenario: Manifest updated with round IDs
    Tool: Bash
    Steps:
      1. Run: `jq '.roundIds | length' .fixture-manifest.json`
    Expected Result: 4.
    Evidence: `.omo/evidence/task-9-manifest.txt`.

  Scenario: Refuses to run without fixtures
    Tool: Bash
    Steps:
      1. With NO `.fixture-manifest.json`: `rm -f .fixture-manifest.json && node scripts/seed-rounds.mjs; echo $?`
    Expected Result: exits non-zero with `Run 'make seed' first` on stderr.
    Evidence: `.omo/evidence/task-9-precond.txt`.

  Scenario: Lock proceeds even when PDF generation fails (chromium missing) — observational
    Tool: Bash
    Steps:
      1. Force PDF generation to fail by setting `CHROMIUM_EXECUTABLE_PATH=/nonexistent-chromium` on the api service (LOCAL: add to `docker-compose.yml` `api.environment`, `docker compose up -d api`; AZURE: `az functionapp config appsettings set` and restart).
      2. Run: `node scripts/seed-rounds.mjs 2>/tmp/seed-rounds.err`
      3. Verify script exit code 0 AND all 4 rounds in manifest.
      4. Verify the would-be-Locked round IS in `Locked` status (lock always succeeds at HTTP level): `curl -s ${BCC_API_BASE_URL}/api/rounds | jq -r '.[] | select(.status == "Locked") | .id'` returns the locked round's id.
      5. Verify API logs contain a warning line: `docker compose logs api 2>&1 | grep "Brief artifact/email processing failed"` (LOCAL) or `az functionapp log tail | grep "Brief artifact/email processing failed"` (AZURE).
    Expected Result: script exit 0; 4 rounds; Locked round reached Locked status; API log shows PDF-gen warning. Confirms lockRound's internal catch works AND seed-rounds doesn't need its own fallback.
    Failure Indicators: script exits non-zero; the would-be-Locked round is NOT in Locked status; no warning in API logs.
    Evidence: `.omo/evidence/task-9-lock-with-pdf-failure.txt`.
  ```

  **Commit**: YES
  - Message: `feat(scripts): seed dev rounds in varied statuses via API`
  - Files: `scripts/seed-rounds.mjs`
  - Pre-commit: all seven QA scenarios pass.

- [x] 10. scripts/wipe-fixtures.mjs: surgical wipe of fixture blobs by manifest - safely re-runnable seed

  **What to do**:
  - Create `scripts/wipe-fixtures.mjs` (ESM, Node).
  - Imports: blobSeed helpers + loadTestConsts + `readFileSync, existsSync, unlinkSync` from `node:fs`.
  - Algorithm:
    1. If `FIXTURE_MANIFEST_PATH` doesn't exist, log `[wipe-fixtures] no manifest; nothing to wipe` and exit 0.
    2. Read manifest. For each `roundIds` entry: delete `rounds/{id}.json`, `round-briefs/{id}.json`, `round-briefs/{id}.pdf` from `data-private`.
    3. For each `pilotIds`: delete `pilots/{id}.json` from `data-private`.
    4. For each `userIds`: delete `users/{id}.json`, `auth/{id}.json` from `data-private`.
    5. For each `clubIds`: delete `clubs/{id}.json` from `data-private`.
    6. For each `teamIds`: delete `club-teams/{id}.json` from `data-private`.
    7. For each `siteIds`: delete `sites/{id}.json` from `data-private`.
    8. Read `user-index.json` private and `pilot-email-index.json` private; remove keys whose values are in `userIds`/`pilotIds`; write back.
    9. Read public `pilots.json` / `clubs.json` / `club-teams.json` / `rounds.json` / `seasons.json`; filter out IDs from manifest; write back.
    10. Read public `seasons/{seasonYear}.json` if `seasonYear` in manifest; if entirely fixture-seeded, delete; else just remove fixture round IDs from its `rounds` array.
    11. Delete `FIXTURE_MANIFEST_PATH` and `PREPARED_ROUND_PATH` (if exists).
    12. Print summary `[wipe-fixtures] OK: N pilots / N clubs / N teams / N rounds / N sites removed`.
  - Parallelize deletes in chunks of 50 (`Promise.all` with chunking).

  **Must NOT do**:
  - Use prefix scans (`listBlobs(prefix)`) — manifest is authoritative.
  - Wipe `config.json` (it might contain non-fixture settings).
  - Wipe the admin user (admin is seeded separately by T7).
  - Touch any blob whose ID is not in the manifest.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: straightforward "delete by ID" loop.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T6, T7, T8, T12)
  - **Blocks**: T16
  - **Blocked By**: T2, T3

  **References**:

  *Pattern References*:
  - `scripts/admin/anonymize-pilot.mjs` - established "delete blob by ID" patterns.
  - `scripts/seed-fixtures.mjs` (T8) - same manifest shape; this is the inverse op.

  *WHY Each Reference Matters*:
  - Manifest-driven wipe is the ONLY safe pattern — prefix scans risk catching real user data.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Wipe after seed produces empty index counts
    Tool: Bash
    Preconditions: T7 + T8 + T9 ran; fixtures exist.
    Steps:
      1. Run: `node scripts/wipe-fixtures.mjs`
      2. Verify: `curl -s http://localhost:3000/blob/pilots.json | jq 'length'` → 0
      3. Verify: `curl -s http://localhost:3000/blob/clubs.json | jq 'length'` → 0
      4. Verify: `curl -s http://localhost:3000/blob/club-teams.json | jq 'length'` → 0
      5. Verify: `curl -s http://localhost:3000/blob/rounds.json | jq 'length'` → 0
      6. Verify: `[ ! -f .fixture-manifest.json ] && echo MANIFEST_GONE`
    Expected Result: all four 0; MANIFEST_GONE printed.
    Evidence: `.omo/evidence/task-10-empty-indexes.txt`.

  Scenario: Admin user survives wipe
    Tool: Bash
    Steps:
      1. After wipe, retry login as admin (use password from `.dev-credentials`).
    Expected Result: HTTP 200 + accessToken.
    Evidence: `.omo/evidence/task-10-admin-survives.txt`.

  Scenario: No manifest = no-op
    Tool: Bash
    Steps:
      1. With no manifest: `node scripts/wipe-fixtures.mjs 2>/tmp/w.err`
      2. `grep "nothing to wipe" /tmp/w.err && echo OK`
    Expected Result: prints `OK`; exit 0.
    Evidence: `.omo/evidence/task-10-noop.txt`.

  Scenario: Re-seed after wipe works
    Tool: Bash
    Steps:
      1. `node scripts/wipe-fixtures.mjs && node scripts/seed-fixtures.mjs`
      2. Verify counts are 500/50/100 again.
    Expected Result: same counts as fresh seed.
    Evidence: `.omo/evidence/task-10-reseed.txt`.
  ```

  **Commit**: YES
  - Message: `feat(scripts): surgical fixture wipe by manifest`
  - Files: `scripts/wipe-fixtures.mjs`
  - Pre-commit: all four QA scenarios.

- [x] 11. scripts/prepare-loadtest.mjs: create load-test round + 50 teams via API + confirm (auto-creates brief), emit prepared-round.json - phase 1 of load-test pipeline

  **What to do**:
  - Create `scripts/prepare-loadtest.mjs` (ESM, Node).
  - Imports: loadTestConsts (including `BCC_API_BASE_URL`, `IS_AZURE_TARGET`, `ADMIN_PASSWORD_OVERRIDE`) + `writeFileSync, readFileSync, chmodSync` from `node:fs` + `fetch` (Node 20 global). **NO blobSeed import needed — this script is now pure HTTP.**
  - Preconditions: read `FIXTURE_MANIFEST_PATH`; if missing → exit 1 with `"Run 'make seed' first (target: ${BCC_API_BASE_URL})"`.
  - Algorithm:
    1. **Admin credential resolution**:
       - If `ADMIN_PASSWORD_OVERRIDE` set (Azure mode): use it directly.
       - Else: read `DEV_CREDENTIALS_PATH` (local mode).
       - If neither available, exit 1 with: `"No admin credentials. Set ADMIN_PASSWORD env (Azure mode) or run 'docker compose up' first (local mode)."`.
    2. Login: `POST ${BCC_API_BASE_URL}/api/auth/login` → JWT.
    3. Create the round: `POST ${BCC_API_BASE_URL}/api/rounds` with body `{ date: <today + 7 days>, siteId: <manifest.siteIds[0]>, seasonYear: manifest.seasonYear }`. **Do NOT pass `status: "Confirmed"`** — `createRound` only stamps the status field; the brief auto-creation only fires inside the dedicated `confirmRound` handler. Always use the two-step pattern.
    4. Capture `roundId` from response.
    5. Add 50 teams: for first 50 fixture club-teams (or build 50 teams from `manifest.clubIds`), `POST ${BCC_API_BASE_URL}/api/rounds/{roundId}/teams` with `{ clubId, teamName }`. Run in chunks of 10 (round blob lease). If `IS_AZURE_TARGET`, use chunks of 5 (cold-start headroom).
    6. Capture each created `teamId` from responses.
    7. **Confirm the round**: `POST ${BCC_API_BASE_URL}/api/rounds/{roundId}/confirm` (empty body). This transitions the round to `Confirmed` AND auto-creates `round-briefs/{roundId}.json` per the brief-lifecycle fix (`apps/api/src/functions/roundsMutate.ts:397-400`). **No direct Blob SDK write is needed.**
    8. (No pre-fill of slots — the k6 register phase tests register-self contention.)
    9. Build `prepared` object:
       ```
       {
         roundId,
         seasonYear,
         siteId,
         teams: [{teamId, place, pilotEmail, pilotPassword, pilotId}, ...],  // 500 entries
         baseUrl: BCC_API_BASE_URL,
         isAzureTarget: IS_AZURE_TARGET
       }
       ```
       For each `(teamN in 1..50, place in 1..10)`: pilot at index `(teamN-1)*10 + (place-1)` → `pilotEmail = pilot{NNN}@bcc.local`, etc.
    10. Write `tests/load/.prepared-round.json` (chmod 600).
    11. Print summary to STDERR: `"[prepare-loadtest] OK: target=${BCC_API_BASE_URL} round={roundId} teams=50 slots=500 status=Confirmed (brief auto-created)"`.

  **Must NOT do**:
  - Hardcode `http://localhost:7071` anywhere — always use `BCC_API_BASE_URL` from loadTestConsts.
  - Write `round-briefs/{roundId}.json` directly via Blob SDK. The brief auto-creates on `confirmRound`. Direct Blob SDK writes would bypass production semantics, would never invoke `buildRoundBrief()`'s derivation logic correctly, and would re-introduce the architectural smell the brief-lifecycle-fix plan removed.
  - Import `@azure/storage-blob` or the `scripts/lib/blobSeed.mjs` helpers. This script is now pure HTTP.
  - Pass `status: "Confirmed"` in `POST /api/rounds` body. `createRound` accepts it but does NOT fire the brief auto-creation hook — only the explicit `POST /confirm` does.
  - Call `POST brief-complete` (that's T12's job — register-self requires Confirmed status).
  - Pre-fill slots (k6 register phase tests register-self contention).
  - Use the rate-limited admin endpoints to add pilots in bulk (skipping respects the user's "full journey" requirement).
  - Refuse to run against Azure (the user has a dedicated test instance; this script is target-agnostic).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: orchestrates a multi-step HTTP sequence (login → create round → bulk add teams → confirm). All over HTTP — no Blob SDK after the brief-lifecycle fix.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES (with rest of Wave 2)
  - **Parallel Group**: Wave 3 (with T9, T14)
  - **Blocks**: T15, T16
  - **Blocked By**: T3, T8

  **References**:

  *Pattern References*:
  - `apps/api/src/functions/roundsMutate.ts:94-180` — `createRound` body shape.
  - `apps/api/src/functions/roundsMutate.ts:397-400` — confirmRound's auto-brief-creation block (landed by the brief-lifecycle-fix plan).
  - `apps/api/src/functions/teams.ts` — add-team endpoint shape (verify path `/api/rounds/{id}/teams`).

  *API/Type References*:
  - `packages/types/src/index.ts` — `Round`, `Team`, `RoundBrief` types (read-only — the API builds the brief; this script never constructs one).

  *WHY Each Reference Matters*:
  - The two-step pattern (create as Proposed, then explicit confirm) is required because `createRound` only stamps the status field — only the dedicated `confirmRound` handler invokes `buildRoundBrief()` to materialize the brief blob. Verifying line 397-400 confirms the brief is written there.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Prepare produces valid prepared-round.json
    Tool: Bash
    Preconditions: T8 done (fixtures), T7 (compose env) applied, API running.
    Steps:
      1. Run: `node scripts/prepare-loadtest.mjs`
      2. Verify: `jq '.teams | length' tests/load/.prepared-round.json` → 500
      3. Verify: `jq '[.teams[].teamId] | unique | length' tests/load/.prepared-round.json` → 50
      4. Verify: `jq -r .roundId tests/load/.prepared-round.json` → non-empty UUID
    Expected Result: 500 teams entries across 50 unique team IDs; roundId set.
    Evidence: `.omo/evidence/task-11-prepared.json`.

  Scenario: Round is in Confirmed status
    Tool: Bash
    Steps:
      1. Use admin JWT to `GET /api/rounds/{roundId}` (or read private blob via node).
      2. Assert `status === "Confirmed"`.
    Expected Result: Confirmed.
    Evidence: `.omo/evidence/task-11-status.txt`.

  Scenario: Brief blob exists for the round (auto-created by confirmRound)
    Tool: Bash
    Steps:
      1. Use admin JWT to `GET ${BCC_API_BASE_URL}/api/rounds/{roundId}/brief`.
      2. Assert HTTP 200; response body is a `RoundBrief` with populated derived fields (`siteName`, `date`, `teams[]`) and undefined narrative fields.
    Expected Result: 200; brief present with derivable fields populated, narrative absent.
    Evidence: `.omo/evidence/task-11-brief.txt`.

  Scenario: Script never imports Blob SDK (regression check after brief-lifecycle fix)
    Tool: Bash
    Steps:
      1. Run: `grep -nE "from ['\\"]\\.?\\.?/lib/blobSeed|@azure/storage-blob" scripts/prepare-loadtest.mjs && echo FAIL || echo PASS`
    Expected Result: prints `PASS` (no Blob SDK imports).
    Evidence: `.omo/evidence/task-11-pure-http.txt`.

  Scenario: Slots NOT pre-filled (register-self will fill)
    Tool: Bash
    Steps:
      1. `GET ${BCC_API_BASE_URL}/api/rounds/{roundId}` with admin JWT.
      2. Assert no slot has `status === "Filled"`.
    Expected Result: all slots empty / available.
    Evidence: `.omo/evidence/task-11-slots-empty.txt`.

  Scenario: Refuses to run without fixtures
    Tool: Bash
    Steps:
      1. With no manifest: `rm -f .fixture-manifest.json && node scripts/prepare-loadtest.mjs; echo $?`
    Expected Result: non-zero exit + helpful message.
    Evidence: `.omo/evidence/task-11-precond.txt`.
  ```

  **Commit**: YES
  - Message: `feat(scripts): prepare load-test round + teams via API (brief auto-creates on confirm)`
  - Files: `scripts/prepare-loadtest.mjs`
  - Pre-commit: all six QA scenarios.

- [x] 12. scripts/transition-loadtest.mjs: POST brief-complete on the prepared round - flip Confirmed → BriefComplete between register and sign phases

  **What to do**:
  - Create `scripts/transition-loadtest.mjs` (ESM, Node).
  - Imports: loadTestConsts (including `BCC_API_BASE_URL`, `ADMIN_PASSWORD_OVERRIDE`) + `readFileSync` from `node:fs` + global `fetch`.
  - Algorithm:
    1. Read `PREPARED_ROUND_PATH` — fail with clear message if missing.
    2. Admin credentials: `ADMIN_PASSWORD_OVERRIDE` if set (Azure mode) else `DEV_CREDENTIALS_PATH` (local mode); fail if neither.
    3. Login: `POST ${BCC_API_BASE_URL}/api/auth/login` → JWT.
    4. Call `POST ${BCC_API_BASE_URL}/api/rounds/{roundId}/brief-complete` with admin JWT, empty body.
    5. Verify HTTP 200; print response status.
    6. Print summary `[transition-loadtest] OK: target=${BCC_API_BASE_URL} round {roundId} → BriefComplete`.

  **Must NOT do**:
  - Hardcode `http://localhost:7071` — always use `BCC_API_BASE_URL`.
  - Modify the prepared-round file.
  - Call any other endpoint.
  - Call `POST /api/rounds/{id}/lock` (that would clear sign-to-fly flags).

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: single HTTP POST.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES (with rest of Wave 2)
  - **Parallel Group**: Wave 2 (with T6, T7, T8, T10)
  - **Blocks**: T16
  - **Blocked By**: T3

  **References**:

  *Pattern References*:
  - `apps/api/src/functions/roundsMutate.ts` `briefCompleteRound` handler - confirms path + body.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Transition flips status to BriefComplete
    Tool: Bash
    Preconditions: T11 ran; round in Confirmed.
    Steps:
      1. Run: `node scripts/transition-loadtest.mjs`
      2. Read round blob; assert `status === "BriefComplete"`.
    Expected Result: BriefComplete.
    Evidence: `.omo/evidence/task-12-bc.txt`.

  Scenario: Refuses without prepared-round
    Tool: Bash
    Steps:
      1. `rm -f tests/load/.prepared-round.json && node scripts/transition-loadtest.mjs; echo $?`
    Expected Result: non-zero exit.
    Evidence: `.omo/evidence/task-12-precond.txt`.
  ```

  **Commit**: YES
  - Message: `feat(scripts): transition load-test round to BriefComplete`
  - Files: `scripts/transition-loadtest.mjs`
  - Pre-commit: both QA scenarios.

- [x] 13. scripts/cleanup-loadtest.mjs: delete the load-test round + cleanup artifacts - leave dev stack in pre-loadtest state

  **What to do**:
  - Create `scripts/cleanup-loadtest.mjs` (ESM, Node).
  - Imports: blobSeed + loadTestConsts (including `BCC_API_BASE_URL`, `IS_AZURE_TARGET`) + `unlinkSync, existsSync` from `node:fs`.
  - Algorithm:
    1. If `PREPARED_ROUND_PATH` missing → log no-op + exit 0.
    2. Read `prepared.roundId`.
    3. Delete `rounds/{roundId}.json` from `data-private`.
    4. Delete `round-briefs/{roundId}.json` and `.pdf` (if exists) from `data-private`.
    5. List blobs under `signatures/{roundId}/` and delete all (these accumulate per sign).
    6. Read public `rounds.json`; filter out the load-test roundId; write back.
    7. Read `seasons/{seasonYear}.json`; remove roundId from its `rounds` array; write back.
    8. Delete `PREPARED_ROUND_PATH` file.
    9. Print `[cleanup-loadtest] OK: target=${BCC_API_BASE_URL} round {roundId} removed`. If `IS_AZURE_TARGET`, also print a reminder: `"WARNING: This deleted blobs from Azure storage at ${BLOB_CONNECTION_STRING}. Verify against the intended target before re-running."`.

  **Must NOT do**:
  - Touch any fixture pilots/clubs/teams (T10 handles those).
  - Use prefix scan to delete more than the load-test round + its signatures.
  - Skip the Azure-target warning print when running against a non-Azurite endpoint (helps the user spot misconfigured connection strings).

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: targeted delete loop.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES (with rest of Wave 2)
  - **Parallel Group**: Wave 4 (with T15)
  - **Blocks**: T16
  - **Blocked By**: T3, T11

  **References**:

  *Pattern References*:
  - `scripts/wipe-fixtures.mjs` (T10) - manifest-driven delete pattern.
  - `apps/api/src/lib/signTofly/ledger.ts` - signature blob path `signatures/{roundId}/{teamId}-{place}-v{briefVersion}.json`.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: After cleanup, round blob is gone
    Tool: Bash
    Preconditions: T11 + T12 + (simulated sign) ran.
    Steps:
      1. Run: `node scripts/cleanup-loadtest.mjs`
      2. Verify: round blob 404 via node read.
      3. Verify: public rounds.json no longer contains the load-test roundId.
      4. Verify: `[ ! -f tests/load/.prepared-round.json ] && echo OK`.
    Expected Result: blob gone, public index updated, prepared file deleted.
    Evidence: `.omo/evidence/task-13-cleanup.txt`.

  Scenario: Signature blobs cleaned up
    Tool: Bash
    Steps:
      1. List `signatures/{roundId}/` via node — assert empty.
    Expected Result: zero blobs under that prefix.
    Evidence: `.omo/evidence/task-13-sigs.txt`.

  Scenario: Fixture pilots/clubs untouched
    Tool: Bash
    Steps:
      1. After cleanup: `curl -s /blob/pilots.json | jq 'length'` → still 500.
    Expected Result: 500.
    Evidence: `.omo/evidence/task-13-fixtures-safe.txt`.
  ```

  **Commit**: YES
  - Message: `feat(scripts): clean up load-test round and artifacts`
  - Files: `scripts/cleanup-loadtest.mjs`
  - Pre-commit: all three QA scenarios.

- [x] 14. docker-compose.yml: add api-init service that bootstraps admin and prints credentials - turn-key dev stack

  **What to do**:
  - Edit `docker-compose.yml`. Add a new service `api-init` after the `api` service definition:
    ```yaml
    api-init:
      image: node:20-alpine
      depends_on:
        api:
          condition: service_healthy
      environment:
        BLOB_CONNECTION_STRING: "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;"
      volumes:
        - ./scripts:/scripts:ro
        - ./package.json:/package.json:ro
        - ./package-lock.json:/package-lock.json:ro
        - ./.dev-credentials:/workspace/.dev-credentials
      working_dir: /workspace
      networks: [bccweb]
      command: >
        sh -c "cp /scripts -r /workspace/ && cd /workspace && npm install --omit=dev --no-audit --no-fund bcryptjs @azure/storage-blob && node scripts/seed-admin.mjs"
    ```
    - Adjust dependency between `web` and `api-init` so `web` waits for `api-init` to complete: `web.depends_on.api-init.condition: service_completed_successfully`.
  - Ensure `.dev-credentials` file is created on host (empty/placeholder) before `docker compose up` so the bind mount works. Add a touch step in Makefile (T16) or document in README.

  **Must NOT do**:
  - Use the `api` container image to run the seed (it has its own entrypoint; conflict).
  - Add the seed command directly to the `api` service `command:` (would re-run on every container restart and slow startup).
  - Use a custom `Dockerfile` for `api-init` — keep it `node:20-alpine` for simplicity (faster cold start than building).
  - Forget the `condition: service_completed_successfully` on the web service.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: compose orchestration with timing dependencies.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: NO (must wait for T6 + T7)
  - **Parallel Group**: Wave 3 (with T9, T11)
  - **Blocks**: —
  - **Blocked By**: T6, T7

  **References**:

  *Pattern References*:
  - `docker-compose.yml` `azurite-init` service - existing one-shot pattern with `service_healthy` dep and `service_completed_successfully` consumer.
  - `scripts/init-storage.mjs` - the existing one-shot script that azurite-init runs.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Fresh stack ⇒ admin credentials in compose output within 60s
    Tool: interactive_bash (tmux for live logs)
    Preconditions: clean repo + `docker compose down -v && rm -rf .azurite .dev-credentials`.
    Steps:
      1. `touch .dev-credentials` (host file for bind mount)
      2. `docker compose up --build 2>&1 | tee /tmp/compose.log &`
      3. Wait up to 90s, then: `grep "BCC ADMIN PASSWORD" /tmp/compose.log`
      4. Extract password: `PW=$(grep -o 'BCC ADMIN PASSWORD: [^ ]*' /tmp/compose.log | head -1 | awk '{print $NF}')`
      5. `curl -X POST http://localhost:7071/api/auth/login -d "{\"email\":\"admin@bcc.local\",\"password\":\"$PW\"}" -H 'Content-Type: application/json' | jq -r .accessToken`
    Expected Result: password appears in log; login returns JWT.
    Evidence: `.omo/evidence/task-14-fresh-stack.txt`.

  Scenario: api-init exits 0 (service_completed_successfully)
    Tool: Bash
    Steps:
      1. `docker compose ps api-init`
      2. Verify `STATUS` column shows `Exited (0)`.
    Expected Result: exit 0.
    Evidence: `.omo/evidence/task-14-exit.txt`.

  Scenario: web service waits for api-init
    Tool: Bash
    Steps:
      1. Inspect: `docker compose config | grep -A 5 "^  web:"` shows `depends_on.api-init` with the success condition.
    Expected Result: dependency present.
    Evidence: `.omo/evidence/task-14-dep.txt`.

  Scenario: Second `docker compose up` (volume preserved) does NOT regenerate password
    Tool: Bash
    Steps:
      1. With Azurite volume intact, run `docker compose up --build` again.
      2. `grep "already exists" /tmp/compose.log`
    Expected Result: idempotency message present; `.dev-credentials` unchanged.
    Evidence: `.omo/evidence/task-14-idempotent.txt`.
  ```

  **Commit**: YES
  - Message: `feat(compose): add api-init service that bootstraps admin and prints credentials`
  - Files: `docker-compose.yml`
  - Pre-commit: all four QA scenarios.

- [x] 15. tests/load/sign-to-fly.js: k6 script with PHASE=register|sign phases - pure HTTP load runner for 500 VUs

  **What to do**:
  - Create `tests/load/sign-to-fly.js` (k6 script).
  - Imports: `import http from 'k6/http'`, `import { check, fail } from 'k6'`.
  - Top-of-module (init context, ONLY here can `open()` be used):
    ```js
    const PREPARED = JSON.parse(open('./.prepared-round.json'));
    const PHASE = (__ENV.PHASE || 'register').toLowerCase();
    if (PHASE !== 'register' && PHASE !== 'sign') {
      throw new Error('PHASE must be register or sign');
    }
    ```
  - Export `options`:
    ```js
    export const options = {
      scenarios: {
        loadtest: {
          executor: 'per-vu-iterations',
          vus: 500,
          iterations: 1,
          maxDuration: '15m',
        },
      },
      // NO thresholds — advisory mode. k6 prints summary stats to stdout; operator observes.
      // k6 thresholds always gate exit code (no advisory option); omitting them is the only
      // way to avoid non-zero exits on transient latency spikes.
    };
    ```
  - Export `setup`: returns `PREPARED` (k6 distributes this to every VU).
  - Export `default function(data)`:
    ```js
    const idx = (__VU - 1) % data.teams.length;
    const slot = data.teams[idx];
    // Login as this pilot to get JWT
    const loginRes = http.post(`${data.baseUrl}/api/auth/login`,
      JSON.stringify({email: slot.pilotEmail, password: slot.pilotPassword}),
      { headers: {'Content-Type': 'application/json'}, tags: {name: 'login'} });
    check(loginRes, {'login 200': r => r.status === 200});
    const token = loginRes.json('accessToken');
    if (!token) { fail('no token'); }

    const auth = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };

    if (PHASE === 'register') {
      const res = http.post(
        `${data.baseUrl}/api/rounds/${data.roundId}/register-self`,
        JSON.stringify({teamId: slot.teamId, preferredPlace: slot.place}),
        { ...auth, tags: {name: 'phase', phase: 'register'} }
      );
      check(res, {'register ok': r => r.status === 200 || r.status === 201});
    } else {
      const res = http.post(
        `${data.baseUrl}/api/rounds/${data.roundId}/teams/${slot.teamId}/pilots/${slot.place}/sign`,
        null,
        { ...auth, tags: {name: 'phase', phase: 'sign'} }
      );
      check(res, {'sign 200': r => r.status === 200});
    }
    ```
  - **NO** Blob SDK calls, **NO** `fs`, **NO** npm imports.

  **Must NOT do**:
  - Use `import { open } from 'k6'` (it's a global, not an import — per Oracle phase 1).
  - Add a `thresholds:` field to `options`. k6 thresholds always cause non-zero exit on breach — there is no advisory variant. Per the user's "advisory only" requirement, thresholds are omitted entirely; latency/error metrics are observed from the k6 summary stdout, not enforced via exit code.
  - Make any non-HTTP calls.
  - Use `sleep()` — we want maximum contention pressure.
  - Pre-resolve `slot.teamId` via lookups inside the default fn (it's pre-computed in setup).

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: k6 ergonomics + ensuring zero Node-isms requires careful authoring.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T13)
  - **Parallel Group**: Wave 4 (with T13)
  - **Blocks**: T16, T17
  - **Blocked By**: T3, T5, T11

  **References**:

  *External References*:
  - k6 docs: `open()` is global in init context; `scenarios.executor` types; `__VU`/`__ENV`; `check`/`fail`; `http` module.

  *Pattern References*:
  - `tests/load/.prepared-round.json` shape (emitted by T11).

  *WHY Each Reference Matters*:
  - k6's Goja runtime is ES5.1-ish — no top-level await, no async/await in init, no Node globals (`process`, `require`, `fs`). Authoring k6 like Node will fail at parse time.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Register phase: all 500 register-self succeed
    Tool: interactive_bash (tmux, k6 has live progress)
    Preconditions: T8 + T11 done; round in Confirmed; T5 (identity-keyed rate limit) deployed so per-pilot 10/min budgets isolate the 500 VUs.
    Steps:
      1. `cd tests/load && k6 run --env PHASE=register sign-to-fly.js`
      2. After completion, read the round blob via node + blobSeed.
      3. Count slots with `status === "Filled"`.
    Expected Result: 500 filled slots; k6 exit code 0; `register ok` check passes for ≥99% of iterations.
    Evidence: `.omo/evidence/task-15-register.txt` (k6 summary), `.omo/evidence/task-15-register-blob.txt` (slot count).

  Scenario: Sign phase: all 500 sign requests reflect on round blob
    Tool: interactive_bash (tmux)
    Preconditions: register phase done; T12 transitioned to BriefComplete.
    Steps:
      1. `k6 run --env PHASE=sign tests/load/sign-to-fly.js`
      2. Read round blob; count slots with `signToFly === true`.
    Expected Result: 500 signToFly flags set; k6 exit 0; check `sign 200` ≥ 99%.
    Evidence: `.omo/evidence/task-15-sign.txt`, `.omo/evidence/task-15-sign-blob.txt`.

  Scenario: 15-minute budget honored
    Tool: Bash
    Steps:
      1. Capture k6 start/end timestamps from output.
    Expected Result: total elapsed for sign phase < 15 minutes.
    Evidence: `.omo/evidence/task-15-budget.txt`.

  Scenario: Invalid PHASE env errors out fast
    Tool: Bash
    Steps:
      1. `k6 run --env PHASE=bogus tests/load/sign-to-fly.js`
    Expected Result: script throws at init with `PHASE must be register or sign`; exit non-zero.
    Evidence: `.omo/evidence/task-15-bad-phase.txt`.
  ```

  **Commit**: YES
  - Message: `feat(loadtest): add k6 sign-to-fly script with register/sign phases`
  - Files: `tests/load/sign-to-fly.js`
  - Pre-commit: all four QA scenarios.

- [x] 16. Makefile: add seed and load-test targets - one-command UX for all testing layers

  **What to do**:
  - Edit `Makefile` (preserve existing targets).
  - Add:
    ```makefile
    seed:
    \tnode scripts/seed-fixtures.mjs

    seed-rounds:
    \tnode scripts/seed-rounds.mjs

    wipe-fixtures:
    \tnode scripts/wipe-fixtures.mjs

    loadtest-prepare:
    \tnode scripts/prepare-loadtest.mjs

    loadtest-register:
    \tcd tests/load && k6 run --env PHASE=register sign-to-fly.js

    loadtest-transition:
    \tnode scripts/transition-loadtest.mjs

    loadtest-sign:
    \tcd tests/load && k6 run --env PHASE=sign sign-to-fly.js

    loadtest-cleanup:
    \tnode scripts/cleanup-loadtest.mjs

    loadtest: loadtest-prepare loadtest-register loadtest-transition loadtest-sign loadtest-cleanup
    ```
  - Add a `.PHONY:` declaration for all new targets.
  - Document each target in a `help:` rule if one exists, or add a header comment.

  **Must NOT do**:
  - Use bash-specific features that break on `/bin/sh`.
  - Add `make seed-admin` (admin seed runs inside docker; not a host-side command).
  - Change existing targets.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: trivial Makefile additions.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES (depends on the scripts existing, not their behavior)
  - **Parallel Group**: Wave 5 (with T17, T18)
  - **Blocks**: —
  - **Blocked By**: T7, T8, T9, T10, T11, T12, T13, T15

  **References**:

  *Pattern References*:
  - existing `Makefile` - tab indentation (not spaces!), `.PHONY:` style.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: All new targets resolve
    Tool: Bash
    Steps:
      1. Run: `for t in seed seed-rounds wipe-fixtures loadtest-prepare loadtest-register loadtest-transition loadtest-sign loadtest-cleanup loadtest; do make -n $t > /dev/null && echo "$t OK"; done`
    Expected Result: all 9 print `OK`.
    Evidence: `.omo/evidence/task-16-targets.txt`.

  Scenario: `make loadtest` chains in correct order
    Tool: Bash
    Steps:
      1. `make -n loadtest`
    Expected Result: dry-run output shows the 5 commands in order: prepare → register → transition → sign → cleanup.
    Evidence: `.omo/evidence/task-16-chain.txt`.

  Scenario: Existing targets still work
    Tool: Bash
    Steps:
      1. `make typecheck` and `make build` both succeed.
    Expected Result: both exit 0.
    Evidence: `.omo/evidence/task-16-existing.txt`.
  ```

  **Commit**: YES
  - Message: `feat(make): add seed and load-test targets`
  - Files: `Makefile`
  - Pre-commit: all three QA scenarios.

- [x] 17. tests/load/README.md: how to install k6, run the pipeline locally, interpret output - on-ramp for anyone running the load test

  **What to do**:
  - Create `tests/load/README.md`.
  - Sections:
    1. **Prerequisites** — k6 installed (`brew install k6` on macOS; `apt install k6` on Linux; or `docker run grafana/k6`). For local mode: Docker stack running (`make dev`), fixtures seeded (`make seed`). For Azure target mode: see "Azure target" section.
    2. **The 5-step pipeline** — explain prepare → register → transition → sign → cleanup; explain WHY it's split (k6 is Goja not Node; status guards force two phases).
    3. **Run it (local)** — `make loadtest` end-to-end; or step-by-step with `make loadtest-prepare && make loadtest-register && ...`.
    4. **Run it (Azure target)** — set env vars, then run the same `make loadtest`:
       ```bash
       export BCC_API_BASE_URL=https://your-loadtest-funcapp.azurewebsites.net
       export BLOB_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net"
       export ADMIN_PASSWORD="<admin password for that Function App>"
       make seed                # one-time per Azure instance
       make loadtest            # repeat as needed
       make loadtest-cleanup    # clean up the loadtest round (fixtures stay)
       ```
       Note: `make seed-rounds` is optional in Azure mode (only useful if you want browsable dev rounds in the SPA).
    5. **Interpreting output** — explain k6's summary: `http_req_duration` (focus on `phase` group), `http_req_failed`, `checks` block. **Summary metrics are advisory; no k6 thresholds are configured because thresholds gate exit code (k6 has no advisory-threshold mode).** Operator reads stdout and decides whether the numbers are acceptable.
    6. **Local vs Azure differences** — flag explicitly:
       - **Cold starts**: first 50-100 requests against Azure Function App hit cold instances and have outlier latency. Consider adding a warm-up step (loop `curl /api/health` 20× before kicking off k6) for cleaner numbers.
       - **Auto-scale instance count**: under 500 VUs Azure scales out. Each new instance has its own empty in-memory rate-limit bucket map. This is fine (each pilot only registers once), but you'll see fan-out latency variance.
       - **Lease semantics**: Azurite's lease retry/backoff differs from real Azure Storage. Don't compare local numbers to Azure numbers as if equivalent — they're different measurement series.
       - **Cost**: each `make loadtest` run = a few thousand storage transactions + ~1100 Function App invocations. Cents to dollars, but non-zero. Set Azure cost alerts if running repeatedly.
    7. **Safety** — Azure mode REQUIRES a dedicated test instance (NOT prod). The scripts do not enforce this — you set the env vars. Document the convention: `BCC_API_BASE_URL` should contain `loadtest` or `staging`, never `prod` or the production hostname.
    8. **Troubleshooting** — common failures:
       - `.prepared-round.json` missing → ran register before prepare.
       - Round in wrong status → ran sign before transition.
       - HTTP 429 on register-self → the per-pilot identity-keyed rate limit (T5) didn't ship to your target; verify `git log` on the Function App's deployed commit.
       - HTTP 500 on sign in Azure mode → likely the deployed Function App is missing the brief-lifecycle fix; verify `git log` on the deployed commit includes the `mergeBriefForLock` helper and the `confirmRound` auto-brief block.
       - Cold-start latency outliers → expected; add a warm-up phase or set k6 `gracefulRampDown` to wider window.
  - ~250-400 lines total (more than original estimate; Azure section adds content).

  **Must NOT do**:
  - Document running against production. The user's documented convention is a dedicated test instance.
  - Include performance baselines or expected thresholds as gates. (k6 has no advisory-threshold mode — adding `options.thresholds` would gate the exit code, contradicting the operator-observes-stdout pattern. Document metrics, not gates.)
  - Compare local Azurite numbers vs Azure numbers as if they're the same measurement — they're not.

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: technical doc.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with T16, T18)
  - **Blocks**: —
  - **Blocked By**: T15

  **References**:

  *Pattern References*:
  - `tests/e2e/README.md` - existing tests README; mirror style.
  - `docs/runbooks/*.md` - operational tone.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: README sections present
    Tool: Bash
    Steps:
      1. `grep -c "^## " tests/load/README.md`
    Expected Result: ≥ 6 sections.
    Evidence: `.omo/evidence/task-17-sections.txt`.

  Scenario: All commands documented are valid
    Tool: Bash
    Steps:
      1. `grep -oE "make [a-z-]+" tests/load/README.md | sort -u | xargs -I{} sh -c 'make -n "{}" > /dev/null && echo "{} OK"'`
    Expected Result: every `make X` mentioned resolves to an existing target.
    Evidence: `.omo/evidence/task-17-cmds.txt`.

  Scenario: Azure target section + safety convention documented
    Tool: Bash
    Steps:
      1. `grep -ci "azure target\|BCC_API_BASE_URL\|dedicated test instance" tests/load/README.md`
    Expected Result: ≥ 3 hits (Azure section + env var documented + safety convention).
    Evidence: `.omo/evidence/task-17-azure-section.txt`.

  Scenario: Local vs Azure differences flagged
    Tool: Bash
    Steps:
      1. `grep -ci "cold start\|lease semantics\|azurite.*differ" tests/load/README.md`
    Expected Result: ≥ 2 hits.
    Evidence: `.omo/evidence/task-17-differences.txt`.
  ```

  **Commit**: YES
  - Message: `docs(loadtest): add tests/load/README`
  - Files: `tests/load/README.md`
  - Pre-commit: all three QA scenarios.

- [x] 18. docs/runbooks/load-testing.md: operational runbook for load testing - covers setup, run, cleanup, abort, common failure modes

  **What to do**:
  - Create `docs/runbooks/load-testing.md`.
  - Sections (per existing runbook style):
    1. **Purpose** — when to use this runbook (local performance investigation, regression check, contention probe; also Azure-instance smoke / capacity check).
    2. **Prerequisites** — k6 installed; for local: docker compose stack + fixtures seeded; for Azure target: dedicated test Function App + storage account + admin credentials.
    3. **Procedure: standard run (local)** — `make loadtest`, expected wall-clock ~5-15 min, what to watch in stdout.
    4. **Procedure: standard run (Azure target)** — required env vars (`BCC_API_BASE_URL`, `BLOB_CONNECTION_STRING`, `ADMIN_PASSWORD`), one-time seed (`make seed`), repeat `make loadtest` cycles, manual `make loadtest-cleanup` between runs. Note: expected wall-clock 10-25 min (cold starts + remote network).
    5. **Procedure: step-by-step with checkpoints** — between each phase, what blob state to inspect; how to verify the round is in the expected status.
    6. **Procedure: abort and recover** — Ctrl-C k6, run `make loadtest-cleanup`, verify pre-test state.
    7. **Azure test-instance configuration (one-time setup)** — what Function App settings MUST be configured before pointing the load test at an Azure instance:
       - `PURETRACK_ENABLED=false` — REQUIRED, otherwise locking the load-test round triggers real PureTrack group creation.
       - `ROUND_BRIEF_EMAILS=""` (empty) — REQUIRED, otherwise the lock step sends real round-brief emails.
       - `ACS_CONNECTION_STRING` — use a non-prod ACS instance, OR omit entirely (email sends fail gracefully when missing).
       - `JWT_SECRET` — must be set (via Key Vault ref) for the API to start; can be the same dev secret OR a dedicated test-env secret.
       - Storage account: separate from prod. Containers `data` (public-blob) + `data-private` (private). Verify CORS settings on `data` for the SPA origin if you also plan to browse manually.
       - Document how to set these via `az functionapp config appsettings set` or via Terraform if the test instance is managed there.
    8. **Why the load test works without bypass env vars** — explain the identity-keyed rate limit (T5): each pilot gets their own 10/min budget on register-self, so 500 VUs sharing one IP are not throttled against each other. This is a permanent production improvement (fixes shared-NAT bug for hill sites), not a test affordance.
    9. **PureTrack mocking** — `PURETRACK_ENABLED=false` in docker-compose (local) and in Azure Function App settings (Azure mode); verify no outbound calls during load test.
    10. **Warm-up recommendation (Azure mode)** — Function App Consumption plan cold starts dominate first 50-100 requests. Suggested pre-test step before `make loadtest`: `for i in $(seq 1 30); do curl -s ${BCC_API_BASE_URL}/api/health > /dev/null; done` to warm at least one instance. Document trade-off: more warm-up = less cold-start noise but doesn't simulate true cold-state.
    11. **Failure modes & remediation** —
       - register-self returns 429 → identity-keyed rate limit may have stuck buckets from prior run; local: restart api (`docker compose restart api`); Azure: trigger a Function App restart (`az functionapp restart`) or wait ~5 min for natural instance recycling.
       - sign returns 409 INVALID_STATE → transition step missed; re-run `make loadtest-transition`.
       - sign returns 500 in Azure mode → likely the deployed Function App is missing the brief-lifecycle fix (`confirmRound` doesn't write the brief blob); verify `git log` on the Function App's deployed commit includes the `mergeBriefForLock` helper and the `confirmRound` auto-brief block. Remediation: redeploy with `make deploy-api`. As a separate sanity check, `prepare-loadtest.mjs` calls `POST /api/rounds/{id}/confirm` then `GET /api/rounds/{id}/brief` — running that GET manually with admin JWT should return 200 with a populated brief if the fix is deployed.
       - bcrypt slow on cold start → first login is cached; warm-up note (see section 10).
       - Azurite OOM with .azurite volume bloat (local) → `docker compose down -v` to reset.
       - p95 latency outlier → likely round-blob lease contention; expected; record number and move on (advisory mode).
       - Azure: surprise PureTrack groups appearing → `PURETRACK_ENABLED` not set to "false"; reconfigure Function App and re-run.
       - Azure: surprise emails sent → `ROUND_BRIEF_EMAILS` not empty on the test instance; reconfigure and re-run.
    12. **Privacy note** — fixture data uses `bcc.local` emails (non-routable TLD); no real users involved. In Azure mode, fixture data lives in your dedicated test storage account — run `make loadtest-cleanup` after every test cycle; run `node scripts/wipe-fixtures.mjs` to fully reset when decommissioning the test instance.
    13. **Cost note (Azure mode only)** — ~1100 Function App invocations + ~3000 storage transactions per `make loadtest` run. Cents per run; dollars per day if running continuously. Set Azure cost alerts on the test instance.
    14. **Safety convention** — `BCC_API_BASE_URL` should contain `loadtest` or `staging` (or similar non-prod marker); never run against the production hostname. The scripts do NOT enforce this — it's the operator's responsibility.
    15. **References** — links to: `tests/load/README.md`, `apps/api/src/lib/rateLimit.ts` (identity-keyed limiter), `apps/api/src/lib/signTofly/*` (signature ledger), `apps/api/src/functions/signatures.ts`, `iac/variables.tf` (Terraform env naming).

  **Must NOT do**:
  - Promise specific performance numbers (advisory mode).
  - Include load-balancer/CDN/prod-specific tuning (out of scope).
  - Reference any rate-limit bypass env var (none exists — the load test works because of the identity-keyed limiter).
  - Document running against production. The test mode is "local docker" OR "dedicated Azure test instance" — never prod.

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: long-form runbook.
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with T16, T17)
  - **Blocks**: —
  - **Blocked By**: T15, T16 (and benefits from T7, T8, T9, T11 being landed so the failure-mode prose can reference real behavior).

  **References**:

  *Pattern References*:
  - `docs/runbooks/alerts.md`, `docs/runbooks/deploy-smoke-failure.md`, `docs/runbooks/cutover.md` - established runbook structure (Purpose / Prerequisites / Procedure / Failure modes / References).

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: All required sections present (covers both local and Azure modes)
    Tool: Bash
    Steps:
      1. `for h in Purpose Prerequisites "standard run (local)" "standard run (Azure target)" "Azure test-instance configuration" "Warm-up recommendation" "Failure modes" "Privacy note" "Cost note" "Safety convention" References; do grep -F "$h" docs/runbooks/load-testing.md > /dev/null && echo "$h OK"; done`
    Expected Result: all 10 print OK.
    Evidence: `.omo/evidence/task-18-sections.txt`.

  Scenario: All make targets referenced exist
    Tool: Bash
    Steps:
      1. `grep -oE "make [a-z-]+" docs/runbooks/load-testing.md | sort -u | xargs -I{} sh -c 'make -n "{}" > /dev/null && echo "{} OK"'`
    Expected Result: every target resolves.
    Evidence: `.omo/evidence/task-18-targets.txt`.

  Scenario: Runbook explains identity-keyed rate limit
    Tool: Bash
    Steps:
      1. `grep -ci "identity.?keyed\|per-pilot\|pilotId" docs/runbooks/load-testing.md`
    Expected Result: ≥ 1 hit (the section explaining why no bypass is needed).
    Evidence: `.omo/evidence/task-18-identity-explained.txt`.

  Scenario: No bypass env var mentioned
    Tool: Bash
    Steps:
      1. `grep "ALLOW_TEST_RATE_LIMIT_BYPASS" docs/runbooks/load-testing.md && echo FAIL || echo PASS`
    Expected Result: prints `PASS` (no such mention).
    Evidence: `.omo/evidence/task-18-no-bypass.txt`.

  Scenario: Azure required env vars documented
    Tool: Bash
    Steps:
      1. `for v in BCC_API_BASE_URL BLOB_CONNECTION_STRING ADMIN_PASSWORD PURETRACK_ENABLED ROUND_BRIEF_EMAILS JWT_SECRET; do grep -F "$v" docs/runbooks/load-testing.md > /dev/null && echo "$v OK"; done`
    Expected Result: all 6 print OK.
    Evidence: `.omo/evidence/task-18-azure-envs.txt`.

  Scenario: Safety convention is present (no prod target)
    Tool: Bash
    Steps:
      1. `grep -ci "never.*prod\|loadtest\|staging" docs/runbooks/load-testing.md`
    Expected Result: ≥ 2 hits.
    Evidence: `.omo/evidence/task-18-safety.txt`.
  ```

  **Commit**: YES
  - Message: `docs(runbook): add load-testing runbook`
  - Files: `docs/runbooks/load-testing.md`
  - Pre-commit: all three QA scenarios.

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.omo/evidence/`. Compare deliverables against plan.

  **Acceptance Criteria**:
  - [ ] Every "Must Have" bullet maps to an implementation artifact (file, env var, blob path).
  - [ ] Every "Must NOT Have" bullet has been grep-verified absent.
  - [ ] Every task T1-T18 has at least one evidence file in `.omo/evidence/task-{N}-*`.
  - [ ] Final report written to `.omo/evidence/final-f1-compliance.md` with line-by-line audit.

  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `make typecheck` + `make test` + privacy scan. Review all changed files for: `as any`/`@ts-ignore`, empty catches, `console.log` left in prod paths, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (`data`/`result`/`item`/`temp`).

  **Acceptance Criteria**:
  - [ ] `make typecheck` exits 0 — evidence: `.omo/evidence/final-f2-typecheck.txt`.
  - [ ] `make test` exits 0 with zero failures — evidence: `.omo/evidence/final-f2-tests.txt`.
  - [ ] `node scripts/privacy-scan.mjs` (after `make seed`) exits 0 — evidence: `.omo/evidence/final-f2-privacy.txt`.
  - [ ] `grep -rn "as any\|@ts-ignore" apps/api/src apps/web/src scripts/` count documented and justified for each remaining occurrence — evidence: `.omo/evidence/final-f2-grep.txt`.
  - [ ] AI-slop review summary written to `.omo/evidence/final-f2-slop.md` listing every changed file with verdict (clean / minor / issue).

  Output: `Typecheck [PASS/FAIL] | Tests [N pass/N fail] | Privacy [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state (`docker compose down -v && rm -rf .azurite && touch .dev-credentials`). Execute the full lifecycle step-by-step (NOT `make loadtest` end-to-end — that includes cleanup which would delete the round blob before verification). Save evidence to `.omo/evidence/final-qa/`.

  **Acceptance Criteria**:
  - [ ] `touch .dev-credentials && docker compose up --build` from clean ⇒ admin password visible in compose log within 90s; login succeeds — evidence: `.omo/evidence/final-qa/01-fresh-stack.txt`.
  - [ ] `make seed` ⇒ pilots/clubs/club-teams counts are exactly 500/50/100; pilot001 + pilot500 both log in — evidence: `.omo/evidence/final-qa/02-seed.txt`.
  - [ ] `make seed-rounds` ⇒ SPA `/rounds` page returns 200 and lists 4 rounds — evidence: `.omo/evidence/final-qa/03-rounds.png` (or curl + jq).
  - [ ] Step-by-step load test: `make loadtest-prepare && make loadtest-register && make loadtest-transition && make loadtest-sign` exits 0. THEN — BEFORE cleanup — query the round blob: `curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:7071/api/rounds/$ROUND_ID | jq '[.teams[].pilots[] | select(.signToFly == true)] | length'` returns exactly `500`. Sign-phase wall-clock < 15 min — evidence: `.omo/evidence/final-qa/04-loadtest-summary.txt` + `.omo/evidence/final-qa/05-sign-count.txt`.
  - [ ] `make loadtest-cleanup` exits 0; round blob 404s afterward — evidence: `.omo/evidence/final-qa/06-cleanup.txt`.
  - [ ] Privacy scan PASS after seed — evidence: `.omo/evidence/final-qa/07-privacy.txt`.
  - [ ] No outbound PureTrack HTTP attempts during entire QA run (verified via `docker compose logs api | grep -i puretrack`) — evidence: `.omo/evidence/final-qa/08-puretrack-skipped.txt`.

  Output: `Compose [PASS/FAIL] | Seed [PASS/FAIL] | Loadtest [PASS/FAIL] | Sign count [N/500] | Cleanup [PASS/FAIL] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (`git log/diff`). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance per task. Detect cross-task contamination: T9 touching T10's files etc. Flag unaccounted changes.

  **Acceptance Criteria**:
  - [ ] Per-task diff vs. spec table written to `.omo/evidence/final-f4-fidelity.md` with columns `task | spec files | diff files | match? | over-creep? | under-build?`.
  - [ ] All 18 tasks marked `MATCH` or have a specific reasoned exception documented.
  - [ ] Zero "unaccounted changes" (files modified that aren't in any task's file list).
  - [ ] Zero "Must NOT do" violations across all tasks (grep-verified).

  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

> Each task commits separately. Conventional Commits format. Sisyphus stages only the files listed per task; if a task accidentally modifies unrelated files, those changes are reverted before commit.

- T1: `chore(gitignore): ignore dev credentials and load-test artifacts` — `.gitignore`
- T2: `feat(scripts): add shared blob-seed helper lib` — `scripts/lib/blobSeed.mjs`, `package.json`, `package-lock.json` (if `bcryptjs` newly added)
- T3: `feat(scripts): add shared load-test constants` — `scripts/lib/loadTestConsts.mjs`
- T4: `feat(api): add PURETRACK_ENABLED guard to puretrack module` — `apps/api/src/lib/puretrack.ts`, related test
- T5: `feat(api): rate-limit identityKey for per-pilot register-self budgets` — `apps/api/src/lib/rateLimit.ts`, `apps/api/src/functions/roundRegistration.ts`, related tests
- T6: `chore(compose): set PURETRACK_ENABLED=false for api` — `docker-compose.yml`
- T7: `feat(scripts): idempotent admin bootstrap for docker compose` — `scripts/seed-admin.mjs`
- T8: `feat(scripts): bulk fixture generator for pilots/clubs/teams/season/sites/config` — `scripts/seed-fixtures.mjs`
- T9: `feat(scripts): seed dev rounds in varied statuses via API` — `scripts/seed-rounds.mjs`
- T10: `feat(scripts): surgical fixture wipe by manifest` — `scripts/wipe-fixtures.mjs`
- T11: `feat(scripts): prepare load-test round + teams via API (brief auto-creates on confirm)` — `scripts/prepare-loadtest.mjs`
- T12: `feat(scripts): transition load-test round to BriefComplete` — `scripts/transition-loadtest.mjs`
- T13: `feat(scripts): clean up load-test round and artifacts` — `scripts/cleanup-loadtest.mjs`
- T14: `feat(compose): add api-init service that bootstraps admin and prints credentials` — `docker-compose.yml`
- T15: `feat(loadtest): add k6 sign-to-fly script with register/sign phases` — `tests/load/sign-to-fly.js`
- T16: `feat(make): add seed and load-test targets` — `Makefile`
- T17: `docs(loadtest): add tests/load/README` — `tests/load/README.md`
- T18: `docs(runbook): add load-testing runbook` — `docs/runbooks/load-testing.md`

---

## Success Criteria

### Verification Commands

```bash
# 1. Fresh dev stack with seeded admin
docker compose down -v && rm -rf .azurite
touch .dev-credentials                                # required: bind-mount target must exist
docker compose up --build 2>&1 | tee /tmp/compose.log &
sleep 60
grep "BCC ADMIN PASSWORD" /tmp/compose.log
PW=$(grep -o "BCC ADMIN PASSWORD: [^ ]*" /tmp/compose.log | awk '{print $NF}')
curl -s -X POST http://localhost:7071/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@bcc.local\",\"password\":\"$PW\"}" | jq '.accessToken' # not null

# 2. Bulk fixtures
make seed
curl -s http://localhost:3000/blob/pilots.json | jq 'length' # 500
curl -s http://localhost:3000/blob/clubs.json | jq 'length' # 50
curl -s http://localhost:3000/blob/club-teams.json | jq 'length' # 100
node scripts/privacy-scan.mjs # exit 0

# 3. Dev rounds for SPA browsing
make seed-rounds
curl -s http://localhost:3000/blob/rounds.json | jq 'length' # 4 (one per status)

# 4. Full load test — run step-by-step so we can verify sign count BEFORE cleanup deletes the round
make loadtest-prepare
make loadtest-register
make loadtest-transition
make loadtest-sign
# Capture sign count BEFORE cleanup (cleanup deletes the round blob)
ROUND_ID=$(jq -r .roundId tests/load/.prepared-round.json)
# Read the round blob via a small node one-liner (Blob SDK or via the API):
TOKEN=$(curl -s -X POST http://localhost:7071/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@bcc.local\",\"password\":\"$PW\"}" | jq -r .accessToken)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:7071/api/rounds/$ROUND_ID \
  | jq '[.teams[].pilots[] | select(.signToFly == true)] | length' # Expected: 500
make loadtest-cleanup                                  # AFTER verification

# 5. Test suite
make test          # zero failures across all workspaces (use this, NOT bun test --filter)
make typecheck     # zero errors
```

### Final Checklist
- [ ] All "Must Have" items present in implementation.
- [ ] All "Must NOT Have" items absent from implementation (grep verified).
- [ ] `make test` PASS.
- [ ] `make typecheck` PASS.
- [ ] `node scripts/privacy-scan.mjs` PASS after seed.
- [ ] Step-by-step load test (`make loadtest-prepare && make loadtest-register && make loadtest-transition && make loadtest-sign`) produces 500 `signToFly=true` flags on the round blob, verified via `curl GET /api/rounds/{id}` BEFORE `make loadtest-cleanup` runs.
- [ ] Rate-limit isolation test passes: two pilots from same IP each have own 10/min budget on register-self.

## Plan Amendments (post-execution record)

During execution, four supplementary commits landed outside the original T1-T18 spec.
Each was driven by a real finding during execution or by an operator directive.

### Wave-4 register-self bug fix (3 commits)

The original T11 spec produced a load-test round shape (50 teams from 50 different clubs,
500 pilots round-robin-distributed) that was incompatible with the `register-self` API
contract (single-organising-club domain model in `roundRegistration.ts:236-284`).
Oracle audit (`.omo/notepads/testing-infrastructure/issues.md`) concluded: fixture-only fix,
defer generic `POST /register` to a separate plan.

- `24c18dd` — `scripts/seed-fixtures.mjs`: add `autoAllocatePilotsToRoundClub: true` to the
  fixture config. Lets the 500 load-test pilots auto-allocate to the round's organising club
  at first register-self.
- `a9332f0` — `scripts/prepare-loadtest.mjs`: pass `organisingClubId: manifest.clubIds[0]` +
  use that same clubId for all 50 teams + shift round date to today+21d (avoids
  DOUBLE_BOOKING collision with seed-rounds.mjs's today+7d round).
- `2e55a83` — `tests/load/sign-to-fly.js`: add in-VU retry-on-500 with exponential backoff
  (for round-blob lease contention) and per-VU `X-Forwarded-For` source IPs (so the IP-keyed
  login rate limit doesn't collapse 500 VUs to one bucket).

### Post-Wave-5 operational chore (1 commit)

- `1794bcd` — `chore(make): move k6 logs from .omo/evidence to logs/load-test (gitignored)`.
  Operator directive: `.omo/` is for OpenCode session state and review evidence; runtime
  operational logs belong in a dedicated gitignored `logs/` directory. Files touched:
  `Makefile` (loadtest-register, loadtest-sign targets), `.gitignore` (add `logs/`),
  `tests/load/README.md` (path reference). Not a regression on any prior task.
