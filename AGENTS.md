# AGENTS.md — bccweb2

BCC (British Club Challenge) competition management web app. React 19 SPA +
Azure Functions v4 API, rewriting a legacy .NET app. **All data lives in Azure
Blob Storage — no DB.** Not yet live: no production data or deployments to
protect, so migration/cutover concerns are forward-looking, not remediation.

> **Keep all AGENTS.md files evergreen.** Source of truth for repo conventions. If any
> statement here no longer matches the code (stale versions, renamed/added/removed
> modules, changed build steps or paths), VERIFY against the files and UPDATE it in
> the same change that revealed the drift — don't just flag it. Accuracy is part of "done".

## Monorepo Layout (npm workspaces)

```
apps/api/         @bccweb/api      — Azure Functions v4 HTTP API (Node 24, ESM, TS)
apps/web/         @bccweb/web      — React 19 SPA (Vite 8, React Router v8, TS)
packages/types/   @bccweb/types    — Shared TS interfaces (no runtime deps)
packages/schemas/ @bccweb/schemas  — Zod schemas, one per blob family (the schema layer)
packages/scoring/ @bccweb/scoring  — Pure scoring: scoreRound(), computeLeague()
iac/              Terraform (Azure), 3 stacks   scripts/  Admin/migration/privacy-scan
tests/e2e/        Playwright E2E (`npm run e2e`)  dist/web/ Vite build output (→ SWA)
```

**Build DAG**: `types → schemas → {scoring, api, web}`; `scoring → api`. Consumers
resolve `@bccweb/*` from each package's `dist/` (`main`/`types` fields), so a
dependency MUST be built before its dependents typecheck. Prefer `make build`
(encodes the order) over `npm run build`; after editing types/schemas, rebuild them
first. `make clean` deletes `dist/` + `*.tsbuildinfo` (stops stale incremental builds).

## Toolchain (pinned in `.mise.toml`)

Node 24.16.0, Terraform `latest` (workflows expect 1.10.x), `azure-functions-core-tools`
4.12.0, npm 11 (ships with Node 24). `mise install` brings these up.

## Dependency management

One root [`package-lock.json`](package-lock.json) for the whole workspace graph — npm
hoists + dedupes so shared tooling resolves to one version and there's a single
audit/Dependabot surface. **Do not split per-app lockfiles** (breaks `@bccweb/*`
symlinking, drifts versions). [`.npmrc`](.npmrc): `engine-strict` + `save-exact`
(no-caret). Updates are security-only via Dependabot (no `dependabot.yml`). Exception:
`scripts/migrate/` is a standalone package **outside** the `workspaces` globs with its
own lockfile (pulls `mssql`, kept out of the deployed tree); root `npm ci` skips it,
`ci.yml` installs it separately for migration unit tests.

## Build / Test / Dev

| Command          | Notes                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `make build`     | Full build in dependency order. Prefer over `npm run build`.              |
| `make typecheck` | `tsc --noEmit` across all workspaces.                                     |
| `make test`      | `vitest run` (workspace mode). **Requires Azurite up for API tests.**     |
| `make test-heavy`| The 3 excluded heavy API tests (see Testing).                            |
| `make dev`       | Full stack via Docker Compose (Azurite + API + Web/Caddy).                |
| `make dev-api` / `dev-web` | Functions host `:7071` (needs Azurite) / Vite dev `:5173`.      |
| `make seed`      | Dev fixtures (500 pilots / 50 clubs / teams / seasons). `seed-rounds` too.|
| `make clean`     | Removes `dist/` AND `*.tsbuildinfo`.                                      |
| `npm run e2e`    | Playwright (`tests/e2e/playwright.config.ts`, base URL `:5173`).          |
| `npm run lint`   | eslint all workspaces + `tests/e2e` + `scripts`; each workspace has its own `lint` (`eslint src --max-warnings 0`). |

Single-file: `npx vitest run path/to/file.test.ts`. Watch: `npm run test:watch`.
Local dev needs Docker (or Podman) for Azurite.

## TypeScript Quirks

- **`apps/api`, `packages/{types,schemas,scoring}`** use `module: NodeNext` → relative
  imports MUST end in `.js` (e.g. `import x from "./lib/blob.js"`), even though sources are `.ts`.
- **`apps/web`** uses `module: ESNext` + `moduleResolution: Bundler` + `noEmit: true`.
  Imports still use `.js` extensions (`from "./pages/Home.js"`) — match that.
- `packages/{types,schemas,scoring}` are `composite: true` with project refs.
- Web build = `tsc --noEmit && vite build` (TS only typechecks; Vite emits).

## Data Storage (Azure Blob)

Two containers, created by `scripts/init-storage.mjs`. **`data`** — public
(`publicAccess = "blob"`), SPA reads directly via `VITE_BLOB_BASE_URL` (dev: Vite
proxies `/blob/* → /devstoreaccount1/data/*`). **`data-private`** — private, API-only
via JWT. `withLease()` / `withPrivateLease()` in
[apps/api/src/lib/blob.ts](file:///Volumes/code/bccweb2/apps/api/src/lib/blob.ts)
give atomic read-modify-write (30s lease).

- **Public** (anon read): `rounds.json`, `seasons.json`, `seasons/{year}.json`,
  `results/{year}.json`, `pilots.json`, `clubs.json`, `club-teams.json`, `sites.json`.
- **Private** (API only): `rounds/{uuid}.json`, `pilots/{uuid}.json` (PII),
  `clubs/{uuid}.json`, `club-teams/{uuid}.json`, `sites/{uuid}.json`, `config.json`,
  `users/{uuid}.json`, `user-index.json`, `auth/{uuid}.json`, `auth/tokens/{hash}.json`,
  `round-briefs/{uuid}.{json,pdf}`, `frequencies/*`, `pilot-season-clubs/*`, `season-clubs/*`.

### Storage Queues

Two queues (created by `scripts/init-storage.mjs`, same storage account as blobs):
`round-brief-pdf` (main) and `round-brief-pdf-poison` (dead-letter after
`maxDequeueCount=5` per `host.json`).

**Async brief-PDF flow**: the lock endpoint (`POST /api/rounds/{id}/lock`) sets
`brief.pdfStatus = "pending"` and `brief.pdfAttemptId` on the round blob, then enqueues
a `{roundId, briefVersion, pdfAttemptId}` job. The `briefPdf` queue-trigger consumer
(`apps/api/src/functions/briefPdf.ts`) renders the PDF, uploads it to
`round-briefs/{uuid}.pdf`, emails it, and flips `pdfStatus` to `ready`. Correctness is
guarded by `pdfAttemptId` + an atomic compare-and-set commit (`commitBriefPdfReady`),
NOT by `briefVersion` or `visibilityTimeout`. Status values: `pending | processing |
ready | failed`. On unlock the PDF status fields are cleared.

**Connection invariant**: both the producer (`apps/api/src/lib/queue.ts`) and the
`app.storageQueue` triggers use the `AzureWebJobsStorage` connection setting. That is
the only setting carrying a `QueueEndpoint` in local/Docker; `BLOB_CONNECTION_STRING` is
blob-only. Never switch the producer to `BLOB_CONNECTION_STRING` — it would silently
break queueing.

**Queue privacy**: `privacy-scan.mjs` does NOT cover Storage Queues. The compensating
control is the strict `BriefPdfJobSchema` (`z.object().strict()`) in
`apps/api/src/lib/queue.ts`, which rejects any key beyond `{roundId, briefVersion,
pdfAttemptId}` at serialisation time so PII can never enter a queue message.

A PR-gated [privacy scanner](file:///Volumes/code/bccweb2/scripts/privacy-scan.mjs)
fails CI if PII leaks into the public container. **Never put PII fields in `data/` blobs.**

### Schema layer

Every blob family has exactly one schema in `packages/schemas`. JSON reads go through
`readJson(client, Schema)`, writes through `writeJson` / `writePrivateJson` (see
`apps/api/src/lib/blobJson.ts`). Use raw `readBlob` / `writeBlob` only for non-JSON
artifacts (PDF, image, `.lock`, audit logs).

- **`BLOB_SCHEMA_MODE`** (Function App env): `observe` (default) heals in memory + emits
  telemetry only; `enforce` strips dead keys on write. Toggling is an app-setting change,
  no redeploy. Flip to `enforce` per `docs/runbooks/alerts.md`.
- **WingClass break-glass**: adding a `WingClass` requires order types → schema → API
  deploy → admin UI emits the new key. Reversing that lets `enforce` reject/strip the field.
- **`DATA_SHAPE_INVALID`**: server-side data-invariant violation; body is `{error, path,
  schema}`, never field values (logged server-side only).
- **`bootstrapAdmin` exception**: `apps/api/src/__tests__/helpers/seed.ts:bootstrapAdmin`
  is the single permitted direct `readBlob`/`writeBlob` call site (API can't create the
  first admin). F2 oracle allowlists it; any new exception must update both the seed.ts
  banner and this section.

## API (`apps/api`)

Entry: [src/index.ts](file:///Volumes/code/bccweb2/apps/api/src/index.ts) imports every
function module — each self-registers via `app.http(...)` or `app.storageQueue(...)`.
**A new function file is dead unless added to `src/index.ts`.**

Modules: `health`, `me`, `meProfile`, `rounds`, `roundsMutate`, `seasons`, `pilots`,
`clubs`, `sites`, `teams`, `flights`, `admin`, `adminWording`, `brief`,
`briefPdf` **(queue-trigger — registers `app.storageQueue(...)` for `round-brief-pdf`
and `round-brief-pdf-poison`; the first non-HTTP triggers in the codebase)**, `puretrack`,
`authFunctions`, `signatures`, `roundRegistration`, `clubTeams`, `seasonClubs`,
`pilotSeasonClubs`, `teamsCaptain`.

Lib helpers: `blob` (storage + lease), `blobJson` (schema read/write), `auth` +
`authHelpers` (HS256 JWT), `roundAuth`, `accountMutation`, `email` (ACS), `http`,
`clientIp`, `pdf` (puppeteer-core + @sparticuz/chromium), `rateLimit`, `recompute`,
`puretrack`, `teamCaptain`, `briefPdf` (PDF status CAS helpers: `setBriefPdfStatus`,
`commitBriefPdfReady`, `sendBriefIfConfigured`), `queue` (enqueue + `BriefPdfJobSchema`
strict guard), `telemetry` + `telemetryRedactor` (App Insights PII scrubber,
set up BEFORE function imports), `signTofly/*` (signature ledger). See
`docs/runbooks/alerts.md#blobhealed-events--blob-heal-storm-alert` for `blob.healed` triage.

**Auth**: bespoke HS256 JWT (`JWT_SECRET` env). Access token 1h, refresh 30d. Roles
`Admin`, `RoundsCoord`, `Pilot`. `getCallerIdentity(req)` returns `CallerIdentity | null`;
`RoundsCoord` users have a `clubId` scoping their writes.

**Env** ([local.settings.example.json](file:///Volumes/code/bccweb2/apps/api/local.settings.example.json)):
`BLOB_CONNECTION_STRING`, `BLOB_CONTAINER_NAME` (`data`), `BLOB_PRIVATE_CONTAINER_NAME`
(`data-private`), `JWT_SECRET` (≥32 chars), `ACS_CONNECTION_STRING`, `ACS_SENDER_ADDRESS`,
`ROUND_BRIEF_EMAILS`, `PURETRACK_*`. Copy the example → `local.settings.json`.

## Web (`apps/web`)

Entry: `src/main.tsx` → [`src/router.tsx`](file:///Volumes/code/bccweb2/apps/web/src/router.tsx)
(React Router v8, `BrowserRouter`). `RequireAuth` / `RequireCoord` wrap protected routes;
unauthenticated → `/login?return=<path>`. `FirstLoginOfSeasonGate` wraps the router to
force re-acceptance of season T&Cs. Pages under
`src/pages/{auth,rounds,results,pilots,admin,club}/`; theme in `src/bcc-theme.css`.

- [`useBlob<T>(path)`](file:///Volumes/code/bccweb2/apps/web/src/hooks/useBlob.ts) — reads
  public blobs directly via `VITE_BLOB_BASE_URL` (dev proxies `/blob/*` → Azurite).
  Returns `{ data, loading, error, notFound }`.
- [`api.get/post/put/delete`](file:///Volumes/code/bccweb2/apps/web/src/lib/api.ts) —
  authenticated `/api/*` fetch wrapper; auto-attaches `Authorization: Bearer <token>`.
- [`useAuth.tsx`](file:///Volumes/code/bccweb2/apps/web/src/hooks/useAuth.tsx): tokens in
  `localStorage` (`bcc_access_token`, `bcc_refresh_token`, `bcc_identity`); auto-refresh near expiry.

**Roles**: `Admin` (all admin pages + writes); `RoundsCoord` (manage rounds + club teams
for own `clubId`, sees `/club` self-service); `Pilot` (read authenticated endpoints, edit
own profile); anon (public blobs only).

## Feature Completeness Rule

Any new feature/endpoint MUST ship with the operator UI in the same PR (or an explicitly
linked follow-up in the same release). Admin-managed data (config, wording, reference data)
MUST have an admin page — an API without an operator UI is not done. Exceptions need a
documented rationale in the PR + an entry here.

## Testing — Critical Gotchas

**Vitest 4.1.9** (root devDep). Root [`vitest.config.ts`](vitest.config.ts) `test.projects`
covers `packages/{scoring,types,schemas}` + `apps/{api,web}`.

**API** ([apps/api/vitest.config.ts](file:///Volumes/code/bccweb2/apps/api/vitest.config.ts)):
- **Per-file Azurite containers**: each file gets its own `test-data-<rand>` /
  `test-priv-<rand>`, deleted in `afterAll`; stale `test-*` (>1h) swept from `127.0.0.1`
  only. Isolation must NOT rely on fresh-worker-per-file — `helpers/setup.ts` calls
  `resetBlobSingletons()` before container creation (contains blast radius: a file
  crashing mid-lease can't stall the next behind a 30s lease timeout).
- `@azure/functions` is **mocked** — `app.http()` populates a registry; tests invoke via
  `getRegisteredHandler(name)`. `email`, `pdf`, `puretrack` mocked too. `helpers/seed.ts`
  seeds via handlers, not direct writes (except allowlisted `bootstrapAdmin`).
- `fileParallelism: false` + `sequence.concurrent: false` — sequential for stable blob state.
- `TEST_BCRYPT_COST` honored only when `NODE_ENV === "test"`; else cost stays 12.
- 3 heavy tests excluded (`blob`, `puretrack`, `telemetry.integration`) — reasons inline;
  run via `make test-heavy`. PureTrack live-API tests are opt-in (`make test-integration`,
  needs `apps/api/.env` + network); self-skip without creds, excluded from CI.

**Web** ([apps/web/vitest.config.ts](file:///Volumes/code/bccweb2/apps/web/vitest.config.ts)):
`jsdom` + `@testing-library/react`; aliases `@bccweb/types` to `packages/types/src` (no
rebuild needed for web tests). **E2E**: Playwright vs `E2E_BASE_URL` (default `:5173`);
CI: 2 retries, 1 worker, `forbidOnly`.

## Infra / Deploy (`iac/`)

Terraform, 3 stacks (see `iac/README.md`): `bootstrap/` (tfstate storage, per-env UMIs/RGs,
GitHub OIDC secrets) → `common/` (LAW + App Insights + ACS email domain) → `service/`
(storage, Function App, SWA, ACS, Key Vault — the stamp). `jwt-secret` is generated
declaratively (ephemeral `random_password` → KV write-only), rotated via `jwt_secret_version`.
KV seeding may 403 on first apply during RBAC propagation — re-apply to recover.

CI (`.github/workflows/`): `ci.yml` (every PR/push to `main`: typecheck, lint, full build,
Vitest incl. heavy tests with Azurite, `docker compose build`); `deploy-dev.yml` (push to
`main` → dev: drift gate → Function App + SWA in parallel, each smoke-tested `/api/health`,
`/api/seasons`, web root; **no auto-rollback**); `deploy-prod.yml` (GitHub release → prod:
release-ancestry check on `main` → same gate + jobs); `terraform.yml` (manual plan/apply
per stack × env; also drift-reconcile); `privacy-scan.yml` (Azurite + seed + `privacy-scan.mjs`,
fails on PII leak). Prod SPA: Static Web App + routes in
[`staticwebapp.config.json`](file:///Volumes/code/bccweb2/apps/web/public/staticwebapp.config.json)
(kept in `apps/web/public/` so Vite copies it to the `dist/web` output-location root the SWA
deploy uploads — SPA fallback, security headers, `/api/*` → Function App); local Docker uses Caddy with the
same proxy shape ([`Caddyfile`](file:///Volumes/code/bccweb2/apps/web/Caddyfile)).

## Operations

Runbooks in `docs/runbooks/`: `alerts`, `cutover`, `decommission`, `deploy-smoke-failure`,
`dns-cutover`, `gdpr-erasure`, `privacy`, `round-club-pilot-decision` — read the relevant
one before the matching op. Migration scripts in `scripts/migrate/` (legacy .NET → blob)
keep state under `.migration-state/` (gitignored); `scripts/admin/anonymize-pilot.mjs` for GDPR erasure.

## Plan Execution (worktrees)

Execute saved plans (`.omo/plans/*.md`) in a **dedicated git worktree**, never the main checkout:

- Create under `.worktrees/<plan-name>` on a **new branch** off the base, e.g.
  `git worktree add .worktrees/pdf-stack-upgrade -b deps/pdf-stack-149-25 origin/main`.
  `.worktrees/` is gitignored — keep throwaway verification artifacts there, uncommitted.
- Ensure the plan uses CORRECT PATHS for the worktree (agents have edited the main checkout by mistake before).
- A fresh worktree has **no `node_modules`/`dist/`/`.codegraph/`** — run
  `npm ci && make build && codegraph init` before editing or typechecking (workspaces
  resolve `@bccweb/*` from `dist/`). After `codegraph init` the codegraph tools work scoped
  to that worktree.
- Do all work inside the worktree; commit only intended source files.
- After the **user approves the completion gate**, OFFER to run the `pr-flow` skill to open
  the PR and drive CI/Copilot review. Don't merge unless asked. On completion, fast-forward
  `main`, then `git worktree remove` + delete the branch.
