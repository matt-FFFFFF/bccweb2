# AGENTS.md — bccweb2

BCC (British Club Challenge) competition management web app. React 19 SPA +
Azure Functions v4 API, rewriting a legacy .NET app. **All data lives in Azure
Blob Storage — no DB.** Not yet live: no production data or deployments to
protect, so migration/cutover concerns are forward-looking, not remediation.

> **Keep all AGENTS.md files evergreen.** Source of truth for repo conventions. If any
> statement here no longer matches the code (stale versions, renamed/added/removed
> modules, changed build steps or paths), VERIFY against the files and UPDATE it in
> the same change that revealed the drift — don't just flag it. Accuracy is part of "done".
> This extends to the human-facing docs linked from any AGENTS.md, including
> [docs/architecture/](docs/architecture/) and [docs/runbooks/](docs/runbooks/): if a
> linked doc drifts from the code, fix it in the same change that revealed the drift.

## Monorepo Layout (npm workspaces)

```
apps/api/         @bccweb/api      — Azure Functions v4 HTTP API (Node 24, ESM, TS)
apps/web/         @bccweb/web      — React 19 SPA (Vite 8, React Router v8, TS)
packages/types/   @bccweb/types    — Shared TS interfaces (no runtime deps)
packages/schemas/ @bccweb/schemas  — Zod schemas, one per blob family (the schema layer)
packages/scoring/ @bccweb/scoring  — Pure scoring: scoreRound(), computeLeague()
iac/              Terraform (Azure), 3 stacks   scripts/  Admin/migration/privacy-scan
tests/e2e/        Playwright E2E (`npm run e2e`)  dist/web/ Vite build output (→ SWA)
docs/architecture/ Human-facing design docs (storage-and-queues.md)
docs/runbooks/    Operational runbooks (alerts, cutover, privacy, load-testing, ...)
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
`ci.yml` installs it separately for migration unit tests. See
[scripts/AGENTS.md](scripts/AGENTS.md) for script-family guidance.

## Build / Test / Dev

| Command          | Notes                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `make build`     | Full build in dependency order. Prefer over `npm run build`.              |
| `make typecheck` | `tsc --noEmit` across all workspaces.                                     |
| `make test`      | `vitest run` (workspace mode). **Requires Azurite up for API tests.**     |
| `make test-heavy`| The 3 excluded heavy API tests (see Testing).                            |
| `make dev`       | Full stack via Docker Compose (Azurite + API + Web/Caddy).                |
| `make dev-api` / `dev-web` | Functions host `:7071` (needs Azurite) / Vite dev `:5173`.      |
| `make seed`      | Generate/reuse private admin credentials, then seed fixtures.              |
| `make seed-rounds` | Optional 4-round browsing data; not a `make loadtest` prerequisite.       |
| `make loadtest`  | Sequential prepare/register/captains/transition/sign/artifact/verify/cleanup status transaction on a dedicated stack. |
| `npm run loadtest:test` | Pure load orchestration/artifact/static contracts; no k6/Azurite.      |
| `make clean`     | Removes `dist/` AND `*.tsbuildinfo`.                                      |
| `npm run e2e`    | Playwright (`tests/e2e/playwright.config.ts`, base URL `:5173`).          |
| `npm run lint`   | eslint all workspaces + `tests/e2e` + `scripts`; each workspace has its own `lint` (`eslint src --max-warnings 0`), then the SPDX header check (`license:check`). |

Single-file: `npx vitest run path/to/file.test.ts`. Watch: `npm run test:watch`.
Local dev needs Docker (or Podman) for Azurite.

**Load testing**: canonical fixtures are 500 pilots / 25 clubs / 50 teams / 10
pilots per team, with 25 coordinators and 50 captains. `make loadtest` is one Node
orchestrator recipe, so `make -j` cannot reorder phases; individual `loadtest-*`
targets remain diagnostic tools. Persisted status rows are exactly
`prepare/register/captains/transition/sign/artifact/verify/cleanup`; queue quiescence
is part of `verify`. Preparation checkpoints exact `loadRoundId` ownership plus a
non-secret target-stack digest before team creation; optional browsing-round seeds pair
their owned IDs with the same digest. The identity includes the API origin, storage/queue
endpoints, and effective public/private container names, and cleanup fails closed if the
current target differs. Register and sign never retry; production
`withPrivateLeaseRetry` owns lease contention. Sign selects 185 slots in disjoint
10/25/50/100 cohorts (315 remain false), with hard per-cohort 201-only,
p95<2s/p99<5s, zero-error/5xx gates. The exact verifier checks artifacts, ledger,
flags, replay and dedicated approximate reflect-queue quiescence. Pre-sign failure
cleans an owned checkpoint; verifier/queue failure preserves all state and forbids
cleanup. See `docs/runbooks/load-testing.md`.

Host-side local verification uses the queue-capable Azurite connection on `127.0.0.1:10001`
when `AzureWebJobsStorage` is absent. Remote targets still require that setting explicitly;
the verifier never falls back to blob-only `BLOB_CONNECTION_STRING`.

Local `make seed` bootstraps `admin@bcc.local` and writes its generated credential only
to the ignored root `.dev-credentials` at mode 0600; the value is never logged.
Subsequent seed/load control scripts consume that file automatically. `ADMIN_PASSWORD`
remains the explicit override. Malformed, linked, foreign-owned, or non-0600 files fail
before API/storage mutation. Script guidance: [scripts/AGENTS.md](scripts/AGENTS.md).

For `make docker-up`, prepare writes the override (when present) into that same private
bind-mounted file, never into Compose environment. Make passes only the host UID/GID to
the root `api-init` container; credential reads accept that exact host owner across the
Linux bind boundary while retaining the regular-file, no-follow, single-link, and 0600
checks. Docker Desktop root-owned mounts continue to satisfy the normal current-owner path.

## License headers (SPDX)

Every comment-capable, git-tracked source file carries a two-line MPL-2.0 SPDX header (copyright line above licence line). The `//` form for TypeScript/JavaScript/MJS:

```
// SPDX-FileCopyrightText: <year> British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
```

Use `#` for Terraform/HCL/YAML/shell/TOML/Dockerfile.dev/Caddyfile/Makefile; `/* */` for CSS.

The bespoke, zero-dependency checker `scripts/spdx-header.mjs` enumerates tracked files via `git ls-files` and is chained into `npm run lint` (local + the CI `lint` job — no separate workflow).

- **New file?** Run `npm run license:fix` to stamp or upgrade in place (idempotent). `npm run license:check` just verifies. `npm run license:test` runs the checker's own node:test suite.
- **Enforcement is PRESENCE-ONLY**: requires the "British Club Challenge authors" copyright line and the `MPL-2.0` licence line; the year is informational and never policed.
- **Scope**: `apps/**`, `packages/**`, `iac/**`, `scripts/**` (including the standalone `scripts/migrate/` package — the gate reaches past eslint's ignore of it) + root config files.
- **Out of scope** (never stamped): JSON/`.jsonc` (no comment syntax), Markdown, declaration files (`*.d.ts`/`.d.mts`/`.d.cts`), `apps/web/index.html`, `.github/FUNDING.yml`, and anything gitignored.

## TypeScript Quirks

- **`apps/api`, `packages/{types,schemas,scoring}`** use `module: NodeNext` → relative
  imports MUST end in `.js` (e.g. `import x from "./lib/blob.js"`), even though sources are `.ts`.
- **`apps/web`** uses `module: ESNext` + `moduleResolution: Bundler` + `noEmit: true`.
  Imports still use `.js` extensions (`from "./pages/Home.js"`) — match that.
- `packages/{types,schemas,scoring}` are `composite: true` with project refs.
- Web build = `tsc --noEmit && vite build` (TS only typechecks; Vite emits).

## Data Storage (Azure Blob)

Two containers, created by `scripts/init-storage.mjs`: **`data`** (public, anon read,
SPA reads directly via `VITE_BLOB_BASE_URL`) and **`data-private`** (API-only via JWT,
holds PII). `withLease()` / `withPrivateLease()` in
[apps/api/src/lib/blob.ts](apps/api/src/lib/blob.ts) give atomic read-modify-write
(30s lease). **Never put PII fields in `data/` blobs** — a PR-gated
[privacy scanner](scripts/privacy-scan.mjs) fails CI if PII leaks into the public
container.

**Storage Queues**: eight queues (same storage account), across four families —
brief PDF, sign-to-fly reflect, rescore, PureTrack group — each a main queue plus a
`-poison` dead-letter (except job-status-tracked rescore, which has no HTTP-visible
retry path but still provisions a poison queue as a host-failure safety net). All
producers/triggers use the `AzureWebJobsStorage` connection only; never
`BLOB_CONNECTION_STRING`. Queue job schemas (`BriefPdfJobSchema`,
`SignToFlyReflectJobSchema`, `PureTrackGroupJobSchema`, `RescoreJobMessageSchema`) are
all `.strict()` so PII can never enter a queue message — `privacy-scan.mjs` does not
cover queues, so these schemas are the compensating control.

Full container/family/flow reference (containers, all eight queues, brief PDF/sign
reflect/rescore/PureTrack flows, CAS/attempt semantics, poison behavior):
[docs/architecture/storage-and-queues.md](docs/architecture/storage-and-queues.md).

### Schema layer

Every blob family has a canonical schema in `packages/schemas`. JSON normally goes through
`readJson` / `writeJson` / `writePrivateJson`; deliberate raw lease/index operations must
justify the exception at their call site. `BLOB_SCHEMA_MODE` (`observe`/`enforce`),
the WingClass break-glass order, `DATA_SHAPE_INVALID`, and the `bootstrapAdmin`
allowlisted-exception rule are detailed in
[packages/schemas/AGENTS.md](packages/schemas/AGENTS.md) and the architecture doc — the
Test raw access in `apps/api/src/__tests__/helpers/seed.ts` is limited to its banner's
allowlist: bootstrap, controlled fixture overrides, deliberately corrupt fixtures, and
assertion reads. Any new category must update its banner and that section.

## API (`apps/api`)

Entry: [src/index.ts](apps/api/src/index.ts) imports every self-registering function entry
module; helpers are imported by their owner. **A new entry module is dead unless added to
`src/index.ts`.** Module map, NodeNext import rule, auth/env, and
test-isolation gotchas: [apps/api/AGENTS.md](apps/api/AGENTS.md). Handler conventions:
[apps/api/src/functions/AGENTS.md](apps/api/src/functions/AGENTS.md). Helper cheat sheet:
[apps/api/src/lib/AGENTS.md](apps/api/src/lib/AGENTS.md).

**Auth**: bespoke HS256 JWT (`JWT_SECRET` env). Access token 1h, refresh 30d. Roles
`Admin`, `RoundsCoord`, `Pilot`. `RoundsCoord` users have a `clubId` scoping their writes.

## Web (`apps/web`)

Entry: `src/main.tsx` → [`src/router.tsx`](apps/web/src/router.tsx). Pages under
`src/pages/{auth,rounds,results,pilots,admin,club}/`; theme in `src/bcc-theme.css`.
Router/hooks/`api.ts`/`useAuth`/roles/test details: [apps/web/src/AGENTS.md](apps/web/src/AGENTS.md).

## Feature Completeness Rule

Any new feature/endpoint MUST ship with the operator UI in the same PR (or an explicitly
linked follow-up in the same release). Admin-managed data (config, wording, reference data)
MUST have an admin page — an API without an operator UI is not done. Exceptions need a
documented rationale in the PR + an entry here.

## Testing — Critical Gotchas

**Vitest 4.1.9** (root devDep). Root [`vitest.config.ts`](vitest.config.ts) `test.projects`
covers `packages/{scoring,types,schemas}` + `apps/{api,web}`. API-specific gotchas
(per-file Azurite containers, mocked `@azure/functions`, heavy/integration exclusions):
[apps/api/AGENTS.md](apps/api/AGENTS.md). Web tests use `jsdom` +
`@testing-library/react`; aliases `@bccweb/types` to `packages/types/src` (no rebuild
needed). **E2E**: Playwright vs `E2E_BASE_URL` (default `:5173`); CI: 2 retries,
1 worker, `forbidOnly`.

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
[`staticwebapp.config.json`](apps/web/public/staticwebapp.config.json)
(kept in `apps/web/public/` so Vite copies it to the `dist/web` output-location root the SWA
deploy uploads — SPA fallback, security headers, `/api/*` → Function App); local Docker uses Caddy with the
same proxy shape ([`Caddyfile`](apps/web/Caddyfile)).

## Operations

Runbooks in `docs/runbooks/`: `alerts`, `cutover`, `decommission`, `deploy-smoke-failure`,
`dns-cutover`, `gdpr-erasure`, `load-testing`, `privacy`, `round-club-pilot-decision` — read the relevant
one before the matching op. Migration scripts in `scripts/migrate/` (legacy .NET → blob)
keep state under `.migration-state/` (gitignored); `scripts/admin/anonymize-pilot.mjs` for GDPR erasure.
Run the tracked manufacturers promotion per `docs/runbooks/manufacturers-move.md` after its
deploy. Script-family guidance: [scripts/AGENTS.md](scripts/AGENTS.md).

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
