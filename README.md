# bccweb2

Competition management web app for the **British Club Challenge** (BCC) hang
gliding & paragliding league. React 18 SPA + Azure Functions v4 API, with all
data stored in Azure Blob Storage (no database). Replaces a legacy .NET app.

## Stack

- **Web**: React 18, Vite 5, React Router v6, TypeScript
- **API**: Azure Functions v4 (Node 20, ESM, programming-model v4), TypeScript
- **Storage**: Azure Blob Storage (two containers: `data` public, `data-private` private)
- **Auth**: HS256 JWT (bespoke), `JWT_SECRET` from Azure Key Vault in prod
- **Hosting**: Static Web App (SPA) + Function App (API), Terraform-managed
- **Email**: Azure Communication Services
- **Tests**: Vitest (unit/integration), Playwright (E2E)

## Repository Layout

```
apps/
  api/                  Azure Functions HTTP API   (@bccweb/api)
  web/                  React SPA                  (@bccweb/web)
packages/
  types/                Shared TS interfaces       (@bccweb/types)
  scoring/              Pure scoring functions     (@bccweb/scoring)
iac/                    Terraform (Azure)
scripts/                Migration, admin, privacy-scan utilities
tests/e2e/              Playwright browser tests
docs/runbooks/          Operational runbooks
```

npm workspaces. **Build order matters**: `types` → `scoring` → `api`; `types` → `web`.
The Makefile encodes this; prefer `make build` over `npm run build`.

## Prerequisites

Install with [mise](https://mise.jdx.dev/) (versions pinned in `.mise.toml`):

```sh
mise install
```

Provides Node 20.20.2, Terraform, and `azure-functions-core-tools` 4.9.0.

You also need:

- Docker (for Azurite — the Azure Storage emulator)
- npm ≥ 10

## Quick Start

```sh
# 1. Install dependencies
npm install

# 2. Build shared packages (required before first dev run)
make build

# 3. Copy local settings for the API
cp apps/api/local.settings.example.json apps/api/local.settings.json

# 4. Start the full stack (Azurite + API + web via Docker Compose)
make dev
```

Then open <http://localhost:3000> (Docker/Caddy) or run the Vite dev server
directly with `make dev-web` and visit <http://localhost:5173>.

### Run pieces individually

```sh
docker compose up azurite      # Storage emulator on :10000
make dev-api                   # Functions host on :7071 (needs Azurite)
make dev-web                   # Vite dev server on :5173 (proxies /api, /blob)
```

## Common Commands

| Command | What it does |
|---|---|
| `make build` | Full build in dependency order |
| `make typecheck` | `tsc --noEmit` across all workspaces |
| `make test` | Run Vitest. **API tests require Azurite running.** |
| `npm run test:watch` | Vitest in watch mode |
| `npm run e2e` | Playwright E2E (see [tests/e2e/README.md](tests/e2e/README.md)) |
| `npm run lint` | ESLint — only `apps/web` has a lint script |
| `make clean` | Remove `dist/` and `*.tsbuildinfo` |
| `make docker-down` | Stop the Docker Compose stack |

Single test file: `npx vitest run path/to/file.test.ts`.

## Data Model

Two Azure Blob containers, created by [`scripts/init-storage.mjs`](scripts/init-storage.mjs):

- **`data`** — public read, SPA fetches JSON blobs directly (results, seasons, indexes).
- **`data-private`** — API-only, requires JWT. Holds PII (pilot profiles, users,
  auth tokens, full round details, briefs).

A PR-gated [privacy scanner](scripts/privacy-scan.mjs) fails CI if PII fields
leak into the public container.

Atomic updates use 30-second blob leases — see `withLease()` /
`withPrivateLease()` in [`apps/api/src/lib/blob.ts`](apps/api/src/lib/blob.ts).

## Auth & Roles

| Role | Capabilities |
|---|---|
| `Admin` | All admin pages, all writes |
| `RoundsCoord` | Manage rounds + club teams for own `clubId`; uses `/club` self-service page |
| `Pilot` | Read authenticated endpoints, edit own profile |
| anonymous | Read public blobs only |

Tokens live in `localStorage` (`bcc_access_token`, `bcc_refresh_token`,
`bcc_identity`). Access tokens last 1 h, refresh tokens 30 d.

## Deployment

Two GitHub Actions workflows deploy on push to `main`:

- [`deploy-api.yml`](.github/workflows/deploy-api.yml) — Functions zip-deploy + `/api/health` smoke test
- [`deploy-web.yml`](.github/workflows/deploy-web.yml) — SWA deploy + root smoke test

Infrastructure is managed by Terraform in [`iac/`](iac/) — see [iac/README.md](iac/README.md) for bootstrap order (separate `iac/bootstrap/` config → root `terraform apply -var-file=env/<env>.tfvars`). Secrets are seeded declaratively via AzAPI data-plane writes (no shell script).

There is **no auto-rollback**. A failed smoke test fails the workflow and
leaves the deploy in place for operator investigation —
see [`docs/runbooks/deploy-smoke-failure.md`](docs/runbooks/deploy-smoke-failure.md).

## Operations

Runbooks in [`docs/runbooks/`](docs/runbooks/) cover alerts, cutover, DNS
cutover, GDPR erasure, privacy incidents, decommission, and the
round/club/pilot decision matrix.

## Documentation

- [AGENTS.md](AGENTS.md) — repo conventions, gotchas, test quirks, infra notes (also useful for humans)
- [apps/api/README.md](apps/api/README.md) — API test prerequisites
- [iac/README.md](iac/README.md) — Terraform bootstrap, secret rotation
- [tests/e2e/README.md](tests/e2e/README.md) — Playwright setup

## License

Private / unlicensed. Internal BCC project.
