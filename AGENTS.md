# AGENTS.md — bccweb2

BCC competition management web app. React 18 SPA + Azure Functions v4 API,
rewriting a legacy .NET app. **All data lives in Azure Blob Storage — no DB.**

## Monorepo Layout (npm workspaces)

```
apps/api/        @bccweb/api     — Azure Functions v4 HTTP API (Node 24, ESM, TS)
apps/web/        @bccweb/web     — React 18 SPA (Vite 8, TS)
packages/types/  @bccweb/types   — Shared TS interfaces (no runtime deps)
packages/scoring/@bccweb/scoring — Pure scoring: scoreRound(), computeLeague()
iac/                             — Terraform (Azure)
scripts/                         — Admin / migration / privacy-scan scripts
tests/e2e/                       — Playwright E2E (separate `npm run e2e`)
dist/web/                        — Vite SPA build output (deployed to SWA)
```

`packages/types` MUST be built before `api`/`web` build — both resolve
`@bccweb/types` from `packages/types/dist/` (the package `main`/`types`
fields point at `dist/`). After editing types, rebuild types before
typechecking dependents, or use `make build`. `make clean` deletes
`tsconfig.tsbuildinfo` so stale incremental builds can't poison the next run.

## Toolchain (pinned in `.mise.toml`)

- Node 24.16.0, Terraform `latest` (workflows expect 1.10.x), `azure-functions-core-tools` 4.12.0
- npm 11 (workspaces, ships with Node 24). `mise install` brings these up.

## Dependency management

One root [`package-lock.json`](package-lock.json) for the whole workspace graph:
npm workspaces hoist + dedupe into a single lockfile, so shared tooling
(`typescript`, `vitest`, `zod`) resolves to one version and there's one
`npm audit` / Dependabot surface. Do **not** split per-app lockfiles — that
breaks `@bccweb/*` symlinking and lets shared versions drift.

`scripts/migrate/` is the one deliberate exception: a standalone package
**outside** the `workspaces` globs with its own `package-lock.json` (it pulls
`mssql`, kept out of the deployed api/web tree). Root `npm ci` skips it; `ci.yml`
runs a separate `npm ci` there for the migration unit tests.

[`.npmrc`](.npmrc) sets `engine-strict=true` (honour the `engines` Node/npm
floor) and `save-exact=true` (new installs pin exact, matching the no-caret
policy). Updates are security-only via Dependabot (repo setting, intentionally
no `dependabot.yml`).

## Build / Test / Dev

| Command          | Notes                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `make build`     | Correct dep order: types → scoring → api; types → web. Prefer this over `npm run build`.      |
| `make typecheck` | `npm run typecheck --workspaces --if-present`                                                 |
| `make test`      | `npx vitest run` (vitest workspace mode, root devDep). **Requires Azurite up for API tests.** |
| `make dev`       | Full stack via Docker Compose (Azurite + API + Web/Caddy)                                     |
| `make dev-api`   | Just the Functions host on `:7071` (Azurite must already be running)                          |
| `make dev-web`   | Vite dev server on `:5173`                                                                    |
| `make clean`     | Removes `dist/` AND `*.tsbuildinfo`                                                           |
| `npm run e2e`    | Playwright (config at `tests/e2e/playwright.config.ts`, base URL `:5173`)                     |
| `npm run lint`   | eslint across **all** workspaces (`--if-present`) plus `tests/e2e` and `scripts`. Each workspace has its own `lint` script (`eslint src --max-warnings 0`). |

Single-file test runs: `npx vitest run path/to/file.test.ts`.
Watch: `npm run test:watch` (root).

## Container Runtime

Check docker and podman.

## Plan Execution (worktrees)

Execute saved plans (`.omo/plans/*.md`) in a **dedicated git worktree**, never in the
main checkout:

- Create the worktree under `.worktrees/<plan-name>` on a **new branch** off the base,
  e.g. `git worktree add .worktrees/pdf-stack-upgrade -b deps/pdf-stack-149-25 origin/main`.
  `.worktrees/` is gitignored — keep throwaway verification artifacts (render harnesses,
  scratch Dockerfiles) there, uncommitted.
- Ensure plan contains CORRECT PATHS for worktree, agents have unintentionally altered files in the main checkout before.
- A fresh worktree has **no `node_modules`/`dist/`** — run `npm ci && make build` in it
  before editing or typechecking (workspaces resolve `@bccweb/types` from `dist/`).
- Do all task work inside the worktree; commit only the intended source files.
- After the **user approves the completion gate**, OFFER to run the `pr-flow` skill to
  open the PR, drive CI to green, and handle the Copilot review loop. Do not merge unless
  the user asks. On completion, fast-forward `main`, then `git worktree remove` and delete
  the branch.

## TypeScript Quirks

- **`apps/api`, `packages/types`, `packages/scoring`** use `module: NodeNext` →
  relative imports MUST end in `.js` (e.g. `import x from "./lib/blob.js"`).
  This applies to source files even though they are `.ts`.
- **`apps/web`** uses `module: ESNext` + `moduleResolution: Bundler` +
  `noEmit: true`. Imports still use `.js` extensions in current code (e.g.
  `from "./pages/Home.js"`) — match that style for consistency.
- `packages/types` and `packages/scoring` are `composite: true` with project refs.
- Web build = `tsc --noEmit && vite build` (TS only typechecks; Vite emits).

## Data Storage (Azure Blob)

Two containers, created by `scripts/init-storage.mjs`:

- **`data`** — public (`publicAccess = "blob"`), SPA reads directly via `VITE_BLOB_BASE_URL` (or Vite dev proxy `/blob/* → /devstoreaccount1/data/*`).
- **`data-private`** — private, API access only via JWT.

`withLease()` / `withPrivateLease()` in [apps/api/src/lib/blob.ts](file:///Volumes/code/bccweb2/apps/api/src/lib/blob.ts)
give atomic read-modify-write (30s lease).

**Public blobs** (anonymous read, SPA hits directly): `rounds.json`, `seasons.json`,
`seasons/{year}.json`, `results/{year}.json`, `pilots.json`, `clubs.json`,
`club-teams.json`, `sites.json`.

**Private blobs** (API only): `rounds/{uuid}.json`, `pilots/{uuid}.json` (PII),
`clubs/{uuid}.json`, `club-teams/{uuid}.json`, `sites/{uuid}.json`, `config.json`,
`users/{uuid}.json`, `user-index.json`, `auth/{uuid}.json`, `auth/tokens/{hash}.json`,
`round-briefs/{uuid}.json`, `round-briefs/{uuid}.pdf`, `frequencies/*`,
`pilot-season-clubs/*`, `season-clubs/*`.

A PR-gated [privacy scanner](file:///Volumes/code/bccweb2/scripts/privacy-scan.mjs)
runs in CI and fails if PII leaks into the public container. **Never put PII fields
in `data/`-container blobs.**

### Schema layer

Every blob family has exactly one schema in `packages/schemas`. Reads go through
`readJson(client, Schema)`, and writes go through `writeJson` / `writePrivateJson`.
Use raw `readBlob` / `writeBlob` only for non-JSON artifacts: PDF, image, `.lock`,
and audit-log files.

### BLOB_SCHEMA_MODE

`BLOB_SCHEMA_MODE` is a Function App env setting. `observe` is the default: it heals
in memory and emits telemetry only. `enforce` strips dead keys on write. Migration PRs
deploy in `observe`; flip to `enforce` only after the KQL is clean per
`docs/runbooks/alerts.md`. Flipping back to `observe` is an app-setting change and
does not require a redeploy.

### WingClass break-glass

Adding a `WingClass` requires this order: types → schema → API deploy → admin UI emits
the new key. Reversing that order causes `enforce` mode to reject or strip the new field.

### bootstrapAdmin exception

`apps/api/src/__tests__/helpers/seed.ts:bootstrapAdmin` is the single permitted direct
`readBlob` / `writeBlob` call site in the repo. The API itself cannot create the first
admin, so the F2 oracle allowlists this exception.

### DATA_SHAPE_INVALID error

`DATA_SHAPE_INVALID` is a server-side data invariant violation. Its response body is
`{error, path, schema}` and never includes field values. Issues are logged server-side
only.

## API (`apps/api`)

Entry: [src/index.ts](file:///Volumes/code/bccweb2/apps/api/src/index.ts) imports
every function module — each module self-registers via `app.http(...)`. **A new
function file is dead unless added to `src/index.ts`.**

Current function modules: `health`, `me`, `authFunctions`, `rounds`, `roundsMutate`,
`seasons`, `pilots`, `clubs`, `sites`, `teams`, `flights`, `admin`, `adminWording`,
`brief`, `puretrack`, `signatures`, `roundRegistration`, `clubTeams`, `seasonClubs`,
`pilotSeasonClubs`, `teamsCaptain`.

Lib helpers: `blob` (storage + lease), `auth` + `authHelpers` (HS256 JWT),
`email` (ACS), `http`, `pdf` (puppeteer-core + @sparticuz/chromium),
`rateLimit`, `recompute`, `puretrack`, `teamCaptain`, `telemetry` +
`telemetryRedactor` (App Insights PII scrubber set up BEFORE function imports),
`signTofly/*` (signature ledger).
See `docs/runbooks/alerts.md#blobhealed-events--blob-heal-storm-alert` for `blob.healed` / blob-heal-storm triage.

**Auth**: bespoke HS256 JWT (`JWT_SECRET` env). Access token 1h, refresh 30d.
Roles: `Admin`, `RoundsCoord`, `Pilot`. `getCallerIdentity(req)` returns
`CallerIdentity | null`. `RoundsCoord` users have a `clubId` scoping their writes.

**Env** ([apps/api/local.settings.example.json](file:///Volumes/code/bccweb2/apps/api/local.settings.example.json)):
`BLOB_CONNECTION_STRING`, `BLOB_CONTAINER_NAME` (`data`), `BLOB_PRIVATE_CONTAINER_NAME`
(`data-private`), `JWT_SECRET` (≥32 chars), `ACS_CONNECTION_STRING`,
`ACS_SENDER_ADDRESS`, `ROUND_BRIEF_EMAILS`, `PURETRACK_*`. Copy
`local.settings.example.json` → `local.settings.json`.

## Feature Completeness Rule

Any new feature or endpoint MUST ship with the UI for the people who operate it — in the same PR or an explicitly linked follow-up merged in the same release. In particular, admin-managed data (config, wording, reference data) MUST have an admin page; an API without an operator UI is not done. Exceptions require a documented rationale in the PR description and an entry here.

## Web (`apps/web`)

Entry: `src/main.tsx` → [`src/router.tsx`](file:///Volumes/code/bccweb2/apps/web/src/router.tsx)
(React Router v8, `BrowserRouter`). `RequireAuth` / `RequireCoord` wrap protected
routes; unauthenticated → `/login?return=<path>`. `FirstLoginOfSeasonGate` wraps
the whole router to force re-acceptance of season T&Cs.

**Data fetching:**

- [`useBlob<T>(path)`](file:///Volumes/code/bccweb2/apps/web/src/hooks/useBlob.ts) —
  reads public blobs directly via `VITE_BLOB_BASE_URL`. In dev, Vite proxies
  `/blob/*` → Azurite `:10000/devstoreaccount1/data`. Returns
  `{ data, loading, error, notFound }`.
- [`api.get/post/put/delete`](file:///Volumes/code/bccweb2/apps/web/src/lib/api.ts) —
  authenticated `fetch` wrapper for `/api/*`. Auto-attaches
  `Authorization: Bearer <token>` from localStorage.

**Auth** ([`src/hooks/useAuth.tsx`](file:///Volumes/code/bccweb2/apps/web/src/hooks/useAuth.tsx)):
tokens in `localStorage` (`bcc_access_token`, `bcc_refresh_token`, `bcc_identity`).
Auto-refreshes on mount when access token is near expiry.

Pages live under `src/pages/{auth,rounds,results,pilots,admin,club}/`. Theme
in `src/bcc-theme.css`.

## Roles

| Role          | Capabilities                                                                        |
| ------------- | ----------------------------------------------------------------------------------- |
| `Admin`       | All admin pages, all writes                                                         |
| `RoundsCoord` | Manage rounds and club teams for their own `clubId`; sees `/club` self-service page |
| `Pilot`       | Read authenticated endpoints, edit own profile                                      |
| (anon)        | Reads public blobs only (results, seasons, pilot list)                              |

## Testing — Critical Gotchas

**Framework**: Vitest 4.1.8 (root devDep). Root [`vitest.config.ts`](vitest.config.ts) uses
`test.projects` to cover `packages/{scoring,types}` and `apps/{api,web}`.

**API tests** ([apps/api/vitest.config.ts](file:///Volumes/code/bccweb2/apps/api/vitest.config.ts)):

- **Per-file Azurite containers**: each test file gets its own `test-data-<rand>` / `test-priv-<rand>` containers (Task 24). They are deleted in `afterAll`, and stale `test-*` containers older than 1h are best-effort swept from `127.0.0.1` only.
- Isolation must **not** depend on vitest fresh-worker-per-file behavior. `helpers/setup.ts` calls `resetBlobSingletons()` before container creation so even `pool: 'threads'` with `singleThread: true` still produces correct per-file containers.
- `@azure/functions` is **mocked** in setup — `app.http()` calls populate a handler registry; tests invoke handlers via `getRegisteredHandler(name)`.
  `email`, `pdf`, `puretrack` modules are also mocked to prevent real calls.
- `helpers/seed.ts` seeds via registered handlers (API-based seeding), not direct blob writes. The one documented exception is `bootstrapAdmin` — annotated inline and allowlisted by F2. Adding any new direct-write exception requires updating both the seed.ts banner and this section.
- `fileParallelism: false` + `sequence.concurrent: false` — tests run sequentially for stable blob state.
- `TEST_BCRYPT_COST` is honored only when `NODE_ENV === "test"`; outside test env it is ignored and the cost stays 12. It cannot be used to weaken production hashing.
- Include is glob-based as of Task 7. Three heavy tests are deliberately excluded (`blob.test.ts`, `puretrack.test.ts`, `telemetry.integration.test.ts`) — each with a reason comment in `vitest.config.ts`. Run them via `make test-heavy`.
- Cross-link the `BLOB_SCHEMA_MODE` behavior in [Data Storage (Azure Blob)](#data-storage-azure-blob); do not duplicate it here.

**Why per-file, not shared with UUID**: a test file crashing mid-lease can leave a shared container holding a lease, and the next file would wait 30s for timeout. Per-file containers contain that blast radius, so cleanup is safe and scoped.

**Web tests** ([apps/web/vitest.config.ts](file:///Volumes/code/bccweb2/apps/web/vitest.config.ts)):
`jsdom` env, `@testing-library/react`. Aliases `@bccweb/types` to
`packages/types/src` so types changes don't need a rebuild for web tests.

**E2E**: `npm run e2e` runs Playwright against `E2E_BASE_URL` (default
`http://localhost:5173`). On CI: 2 retries, 1 worker, `forbidOnly`.

## Infra / Deploy (`iac/`)

Terraform is split into three stacks (see `iac/README.md`): `bootstrap/` (tfstate storage, per-env UMIs/RGs, GitHub OIDC secrets), `common/` (per-env LAW + App Insights + ACS email domain), `service/` (storage, Function App, SWA, ACS, Key Vault — the stamp).

**Bootstrap order (first deploy)**: `terraform -chdir=iac/bootstrap init && terraform -chdir=iac/bootstrap apply` (provisions tfstate storage + per-env identities/RGs/secrets) → `terraform -chdir=iac/common init -backend-config=../env/common-<env>.backend.hcl && terraform -chdir=iac/common apply -var-file=../env/common-<env>.tfvars` → `terraform -chdir=iac/service init -backend-config=../env/<env>.backend.hcl && terraform -chdir=iac/service apply -var-file=../env/<env>.tfvars`. KV secrets are seeded declaratively via AzAPI data-plane writes; first-apply may 403 on RBAC propagation — re-apply to recover.

`jwt-secret` is generated declaratively (ephemeral `random_password` → KV write-only) and rotated via the `jwt_secret_version` per-stamp variable.

CI: `.github/workflows/`

- `ci.yml` — every PR + push to `main`: typecheck, lint (all workspaces), full build
  in dependency order, Vitest (incl. heavy lib tests with Azurite up), and
  `docker compose build`.
- `deploy-dev.yml` — every push to `main` deploys to **dev**: a Terraform drift
  gate first, then the Function App and SWA in parallel. The API job builds,
  `npm prune --omit=dev`, then `rsync --copy-links` (workspace symlinks get
  dereferenced into the zip) and deploys via `Azure/functions-action`; both jobs
  smoke-test (`/api/health` + `/api/seasons`, web root). **No auto-rollback** —
  a failed smoke leaves the deploy in place for manual investigation.
- `deploy-prod.yml` — publishing a GitHub **release** deploys to **prod**: a
  release-ancestry check (commit must be on `main`), the same drift gate, then
  the same Functions + SWA deploy jobs.
- `terraform.yml` — manual `plan`/`apply` for any stack (`common`/`service`) ×
  env (`dev`/`prod`); also the drift-reconcile path the deploy gates point at.
- `privacy-scan.yml` — every PR + push to main. Spins up Azurite, seeds clean
  public blobs, runs `scripts/privacy-scan.mjs`. Fails the PR on PII leak.

Production SPA hosting: Static Web App + custom routes in
[`apps/web/staticwebapp.config.json`](file:///Volumes/code/bccweb2/apps/web/staticwebapp.config.json)
(SPA fallback, security headers; `/api/*` proxies to Function App).
Local Docker hosting uses Caddy with the same proxy shape
([`apps/web/Caddyfile`](file:///Volumes/code/bccweb2/apps/web/Caddyfile)).

## Operations

Runbooks in `docs/runbooks/`: `alerts`, `cutover`, `decommission`,
`deploy-smoke-failure`, `dns-cutover`, `gdpr-erasure`, `privacy`,
`round-club-pilot-decision`. Read the relevant one before doing the corresponding op.

Migration scripts in `scripts/migrate/` (legacy .NET → blob) maintain state under
`.migration-state/` (gitignored). `scripts/admin/anonymize-pilot.mjs` for GDPR erasure.
