# AGENTS.md — bccweb2 Project Reference

## Overview
BCC competition management web app. React 18 SPA + Azure Functions v4 API backend, rewriting a legacy .NET app. All data stored in Azure Blob Storage (no database).

## Monorepo Structure (npm workspaces)

```
apps/api/        @bccweb/api     — Azure Functions v4 HTTP API (Node 20, ESM, TypeScript)
apps/web/        @bccweb/web     — React 18 SPA (Vite 5, TypeScript)
packages/types/  @bccweb/types   — Shared TypeScript interfaces/types (no runtime deps)
packages/scoring/@bccweb/scoring — Pure scoring logic: scoreRound(), computeLeague()
dist/web/                        — Vite production build output
iac/                             — Terraform infrastructure
scripts/                         — One-off admin/migration scripts
```

**Build order** (enforced in Makefile): `types` → `scoring` → `api`; `types` → `web`

`packages/types` must be built (`tsc`) before `api` or `web` can build — both resolve
`@bccweb/types` from `packages/types/dist/` via `package.json` `main`/`types` fields.
After `make clean`, `tsbuildinfo` files are also deleted to prevent stale incremental builds.

## Key Config Files

| File | Purpose |
|---|---|
| `tsconfig.base.json` | Shared TS options: ES2022, NodeNext, strict, declarations |
| `.mise.toml` | Tool versions: Node 20.20.2, Terraform 1.10.5, func 4.9.0 |
| `Makefile` | Build (`make build`), dev (`make dev`), test (`make test`), clean (`make clean`) |
| `docker-compose.yml` | Azurite (storage emulator) + API + Web (Caddy) |
| `vitest.workspace.ts` | Vitest workspace config — lists testable packages |

## Data Storage

Two Azure Blob Storage containers:

- **`data`** — public (`publicAccess = "Blob"`), SPA reads directly (no API hop)
- **`data-private`** — private (`publicAccess = "None"`), API access only

`withLease()` / `withPrivateLease()` in `apps/api/src/lib/blob.ts` provides atomic
read-modify-write (30s lease) on either container.

Public blob paths (SPA reads via `useBlob` / `VITE_BLOB_BASE_URL`):
- `rounds.json` — round index
- `seasons.json`, `seasons/{year}.json`, `results/{year}.json` — season/league data
- `pilots.json` — pilot index (summary only)
- `clubs.json`, `club-teams.json` — club and team indexes
- `sites.json` — sites index

Private blob paths (API only, requires authentication):
- `rounds/{uuid}.json` — full round details (pilot lists, scores, flights)
- `pilots/{uuid}.json` — pilot profiles (medical, emergency contacts, phone)
- `clubs/{uuid}.json`, `club-teams/{uuid}.json`, `sites/{uuid}.json` — full detail records
- `config.json` — admin configuration
- `users/{uuid}.json`, `user-index.json` — user records and email→id lookup
- `auth/{uuid}.json`, `auth/tokens/{hash}.json` — credentials and short-lived tokens
- `round-briefs/{uuid}.json`, `round-briefs/{uuid}.pdf` — pilot safety briefs

## API (`apps/api`)

Entry: `src/index.ts` imports all function modules; each registers via `app.http(...)`.
Lib: `src/lib/blob.ts` (storage), `src/lib/auth.ts` (JWT middleware), `src/lib/email.ts` (ACS).

**Auth**: Bespoke HS256 JWT (`JWT_SECRET` env var). Access token 1h, refresh token 30d.
Roles: `Admin`, `RoundsCoord`, `Pilot`. `getCallerIdentity(req)` returns `CallerIdentity | null`.
`RoundsCoord` users have a `clubId` on their `User` record scoping their write access.

Function modules: `health`, `me`, `authFunctions`, `rounds`, `roundsMutate`, `seasons`,
`pilots`, `clubs`, `clubTeams`, `sites`, `teams`, `flights`, `admin`, `brief`, `puretrack`.

## Web (`apps/web`)

Entry: `src/main.tsx` → `src/router.tsx` (React Router v6 `BrowserRouter`).
`RequireAuth` wraps protected routes; redirects to `/login?return=<path>` when signed out.

**Data fetching**:
- `useBlob<T>(path)` — reads public blobs directly via `VITE_BLOB_BASE_URL`; in dev,
  Vite proxies `/blob/*` → Azurite. Returns `{ data, loading, error, notFound }`.
- `api.get/post/put/delete` (`src/lib/api.ts`) — authenticated fetch wrapper for `/api/*`.
  Auto-attaches `Authorization: Bearer <token>` from localStorage.

**Auth** (`src/hooks/useAuth.ts`): tokens in localStorage (`bcc_access_token`,
`bcc_refresh_token`, `bcc_identity`). Auto-refreshes on mount if access token near expiry.

Key pages: `Home`, `RoundsList`, `RoundDetail`, `RoundManage`, `League`, `RoundResults`,
`PilotsList`, `PilotProfile`, `Login`, `Register`, `AdminUsers`, `AdminClubs`, `AdminSites`,
`AdminConfig`, `MyClub` (`/club` — RoundsCoord self-service team management).

## Roles & Permissions Summary

| Role | Can do |
|---|---|
| `Admin` | Everything |
| `RoundsCoord` | Manage rounds and club teams for their own `clubId` |
| `Pilot` | Read authenticated data, view own profile |
| (unauthenticated) | Read public blobs (results, seasons, pilot list) |

## Testing

**Framework**: Vitest 4.1.2 (root devDep, workspace mode).
Run: `make test` or `npx vitest run`. Watch: `npm run test:watch`. Coverage: `npm run test:coverage`.

Current test coverage:
- `packages/scoring` — 16 tests covering `scoreRound()` and `computeLeague()` (`src/__tests__/scoring.test.ts`)
- `apps/api` — no tests yet
- `apps/web` — no tests yet

Test implementation plan: `.opencode/plans/test-implementation.md`
