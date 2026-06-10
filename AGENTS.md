# AGENTS.md — bccweb2

BCC competition management web app. React 18 SPA + Azure Functions v4 API,
rewriting a legacy .NET app. **All data lives in Azure Blob Storage — no DB.**

## Monorepo Layout (npm workspaces)

```
apps/api/        @bccweb/api     — Azure Functions v4 HTTP API (Node 20, ESM, TS)
apps/web/        @bccweb/web     — React 18 SPA (Vite 5, TS)
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

- Node 20.20.2, Terraform `latest` (workflows expect 1.10.x), `azure-functions-core-tools` 4.9.0
- npm ≥ 10 (workspaces). `mise install` brings these up.

## Build / Test / Dev

| Command | Notes |
|---|---|
| `make build` | Correct dep order: types → scoring → api; types → web. Prefer this over `npm run build`. |
| `make typecheck` | `npm run typecheck --workspaces --if-present` |
| `make test` | `npx vitest run` (vitest workspace mode, root devDep). **Requires Azurite up for API tests.** |
| `make dev` | Full stack via Docker Compose (Azurite + API + Web/Caddy) |
| `make dev-api` | Just the Functions host on `:7071` (Azurite must already be running) |
| `make dev-web` | Vite dev server on `:5173` |
| `make clean` | Removes `dist/` AND `*.tsbuildinfo` |
| `npm run e2e` | Playwright (config at `tests/e2e/playwright.config.ts`, base URL `:5173`) |
| `npm run lint` | **Only `apps/web` has a lint script** (eslint). Other workspaces have none. |

Single-file test runs: `npx vitest run path/to/file.test.ts`.
Watch: `npm run test:watch` (root).

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

## API (`apps/api`)

Entry: [src/index.ts](file:///Volumes/code/bccweb2/apps/api/src/index.ts) imports
every function module — each module self-registers via `app.http(...)`. **A new
function file is dead unless added to `src/index.ts`.**

Current function modules: `health`, `me`, `authFunctions`, `rounds`, `roundsMutate`,
`seasons`, `pilots`, `clubs`, `sites`, `teams`, `flights`, `admin`, `adminWording`,
`brief`, `puretrack`, `signatures`, `roundRegistration`, `clubTeams`, `seasonClubs`,
`pilotSeasonClubs`, `frequencies`, `teamsCaptain`.

Lib helpers: `blob` (storage + lease), `auth` + `authHelpers` (HS256 JWT),
`email` (ACS), `http`, `pdf` (puppeteer-core + @sparticuz/chromium),
`rateLimit`, `recompute`, `puretrack`, `teamCaptain`, `telemetry` +
`telemetryRedactor` (App Insights PII scrubber set up BEFORE function imports),
`signTofly/*` (signature ledger).

**Auth**: bespoke HS256 JWT (`JWT_SECRET` env). Access token 1h, refresh 30d.
Roles: `Admin`, `RoundsCoord`, `Pilot`. `getCallerIdentity(req)` returns
`CallerIdentity | null`. `RoundsCoord` users have a `clubId` scoping their writes.

**Env** ([apps/api/local.settings.example.json](file:///Volumes/code/bccweb2/apps/api/local.settings.example.json)):
`BLOB_CONNECTION_STRING`, `BLOB_CONTAINER_NAME` (`data`), `BLOB_PRIVATE_CONTAINER_NAME`
(`data-private`), `JWT_SECRET` (≥32 chars), `ACS_CONNECTION_STRING`,
`ACS_SENDER_ADDRESS`, `ROUND_BRIEF_EMAILS`, `PURETRACK_*`. Copy
`local.settings.example.json` → `local.settings.json`.

## Web (`apps/web`)

Entry: `src/main.tsx` → [`src/router.tsx`](file:///Volumes/code/bccweb2/apps/web/src/router.tsx)
(React Router v6, `BrowserRouter`). `RequireAuth` / `RequireCoord` wrap protected
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

| Role | Capabilities |
|---|---|
| `Admin` | All admin pages, all writes |
| `RoundsCoord` | Manage rounds and club teams for their own `clubId`; sees `/club` self-service page |
| `Pilot` | Read authenticated endpoints, edit own profile |
| (anon) | Reads public blobs only (results, seasons, pilot list) |

## Testing — Critical Gotchas

**Framework**: Vitest 4.1.8 (root devDep). Root [`vitest.config.ts`](vitest.config.ts) uses
`test.projects` to cover `packages/{scoring,types}` and `apps/{api,web}`.

**API tests** ([apps/api/vitest.config.ts](file:///Volumes/code/bccweb2/apps/api/vitest.config.ts)):

- **Require a running Azurite** (`docker compose up azurite`). Setup files
  ([helpers/setup.ts](file:///Volumes/code/bccweb2/apps/api/src/__tests__/helpers/setup.ts),
  [helpers/azurite.ts](file:///Volumes/code/bccweb2/apps/api/src/__tests__/helpers/azurite.ts))
  default `BLOB_CONNECTION_STRING` to Azurite's well-known dev string and create
  both `data` + `data-private` containers in `beforeAll`.
- `@azure/functions` is **mocked** in setup — `app.http()` calls populate a
  handler registry; tests invoke handlers via `getRegisteredHandler(name)`.
  `email`, `pdf`, `puretrack` modules are also mocked to prevent real calls.
- `fileParallelism: false` + `sequence.concurrent: false` — tests run
  sequentially for stable blob state. **Do not assume parallel execution.**
- No `afterEach` blob cleanup — each test uses `crypto.randomUUID()` for
  unique IDs to avoid collisions across files.
- The `include` array is partly explicit, not pure-glob: `src/__tests__/**`
  and `src/functions/__tests__/**` are globbed, but individual `src/lib/__tests__/*.test.ts`
  files are listed by name. **New lib test files often need to be added to
  the `include` array** or they will silently not run. (Several heavier tests
  like `lib/__tests__/puretrack.test.ts`, `blob.test.ts`,
  `telemetry.integration.test.ts` are deliberately excluded.)

**Web tests** ([apps/web/vitest.config.ts](file:///Volumes/code/bccweb2/apps/web/vitest.config.ts)):
`jsdom` env, `@testing-library/react`. Aliases `@bccweb/types` to
`packages/types/src` so types changes don't need a rebuild for web tests.

**E2E**: `npm run e2e` runs Playwright against `E2E_BASE_URL` (default
`http://localhost:5173`). On CI: 2 retries, 1 worker, `forbidOnly`.

## Infra / Deploy (`iac/`)

Terraform manages: RG, storage, Function App, SWA, ACS, Key Vault.

**Bootstrap order (first deploy)**: `terraform -chdir=iac/bootstrap init && terraform -chdir=iac/bootstrap apply` (provisions tfstate storage) → populate `iac/env/<env>.backend.hcl` from bootstrap outputs → `terraform -chdir=iac init -backend-config=env/<env>.backend.hcl` → `terraform -chdir=iac apply -var-file=env/<env>.tfvars`. KV secrets are seeded declaratively via AzAPI data-plane writes; first-apply may 403 on RBAC propagation — re-apply to recover.

`jwt-secret` is generated declaratively (ephemeral `random_password` → KV write-only) and rotated via the `jwt_secret_version` per-stamp variable.

CI: `.github/workflows/`

- `deploy-api.yml` — push to `main` touching `apps/api/**` or shared packages.
  Builds, prunes devDeps, rsyncs node_modules with `--copy-links` (workspace
  symlinks get dereferenced into the zip), deploys via `Azure/functions-action`,
  then smoke-tests `/api/health` and `/api/seasons`. **No auto-rollback** —
  failure leaves the deploy in place for manual investigation.
- `deploy-web.yml` — push to `main` touching `apps/web/**` or `packages/types/**`.
  Builds, deploys to SWA (`skip_app_build: true`, `output_location: ../../dist/web`),
  smoke-tests root URL. PR events use `action: 'close'`/`'upload'` for preview envs.
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
