# Test Implementation Plan

## Phase Progress

### Phase 1 — Foundation (DONE)
Steps 1-2: Vitest setup, Jest migration. Build and all 16 existing tests verified passing under Vitest.

### Phase 2 — Blob split security + harness (DONE)
Steps 3-5: API test harness (Azurite lifecycle, seed factories, mock handler invocation),
blob split security tests (19 tests), and blob container routing tests (3 tests).
Total: 22 new API integration tests, all passing. 38 tests total across the monorepo.

### Phase 3 — Auth flow tests (NEXT)
Steps 6-8: Register, login, token refresh, role-based access control.

### Phase 4 — API endpoint contract tests
Steps 9-15: HTTP function modules — happy paths, error cases, response shapes.

### Phase 5 — Scoring & recompute tests
Steps 16-17: Expand scoring coverage, add recompute pure-logic tests.

### Phase 6 — Web hook/lib tests
Steps 18-20: `useAuth`, `api.ts`, `useBlob` — client-side critical logic.

### Phase 7 — CI integration
Step 21: GitHub Actions test workflow on PR.

---

## Principles

- **Vitest everywhere.** Replace Jest in `packages/scoring`, use Vitest for all new tests.
  Rationale: native ESM, fast, same config shape, works with the existing `NodeNext` + ES2022
  TS setup without the `--experimental-vm-modules` hack Jest needs.
- **Real Azurite, no mocks for storage.** API tests spin up Azurite (already in
  `docker-compose.yml`), seed both containers, and hit real blob storage. Mocking
  `BlobServiceClient` would defeat the purpose — we need to prove the container routing
  works for real.
- **`msw` for web tests.** Mock Service Worker intercepts `fetch` at the network level
  for frontend hook/lib tests. No need for a running API server.
- **Shared test utilities.** Seed helpers, auth helpers, and Azurite lifecycle management
  live in a shared location so all API test files can reuse them.
- **Fast feedback.** Tests must run in < 30s locally. Azurite starts in ~1s.
  No E2E/Playwright in this plan (separate future effort).

---

## Changes Required

### 1. Add Vitest to the monorepo root ✅ DONE

Installed `vitest` 4.1.2 and `@vitest/coverage-v8` 4.1.2 as root dev dependencies.

Added root `vitest.workspace.ts`:
```ts
export default ["packages/scoring", "apps/api"];
```
(Will expand to include `apps/web` as its test config is added.)

Updated root `package.json` scripts:
```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
```

Updated `Makefile` `test` target to `npx vitest run`.

### 2. Migrate `packages/scoring` from Jest to Vitest ✅ DONE

- Added `packages/scoring/vitest.config.ts` with `test.include: ["src/**/*.test.ts"]`
- Removed `jest` (^30.3.0), `ts-jest` (^29.1.4) devDeps and entire `"jest"` config block
  from `package.json` (215 packages pruned from node_modules)
- Removed `"test"` script from `packages/scoring/package.json` (Vitest runs from root)
- Added `import { describe, test, expect } from "vitest"` to `scoring.test.ts`
- All 16 tests pass in 161ms

### 3. API test harness — Azurite lifecycle + seed utilities ✅ DONE

Created `apps/api/src/__tests__/helpers/` with four modules:

**`helpers/setup.ts`** — Environment variables, `vi.mock("@azure/functions")` to capture
handler registrations (handlers aren't exported, only passed to `app.http()`), email mock.

**`helpers/azurite.ts`** — Azurite container lifecycle:
- `beforeAll`: creates both containers ("data", "data-private") idempotently
- No `afterEach` cleanup — each test uses `randomUUID()` so tests don't collide.
  Blob cleanup was removed because Vitest workspace mode runs test files concurrently,
  and one file's `afterEach` would delete blobs mid-execution of another file's tests.

**`helpers/seed.ts`** — Test data factories:
- `makeUser(overrides?)` → writes `users/{id}.json` + `auth/{id}.json` + `user-index.json` to private
- `makePilot(overrides?)` → writes `pilots/{id}.json` to private + appends to `pilots.json` (public)
- `makeRound(overrides?)` → writes `rounds/{id}.json` to private + appends to `rounds.json` (public)
- `makeClub(overrides?)` → writes `clubs/{id}.json` to private + appends to `clubs.json` (public)
- `makeSite(overrides?)` → writes `sites/{id}.json` to private + appends to `sites.json` (public)
- `makeClubTeam(overrides?)` → writes `club-teams/{id}.json` to private + appends to `club-teams.json` (public)
- `makeConfig(overrides?)` → writes `config.json` to private
- Low-level: `writePublicJson`, `writePrivateJson`, `readPublicJson`, `readPrivateJson`, `publicBlobExists`, `privateBlobExists`

**`helpers/api.ts`** — Mock HTTP request builder + handler invocation:
- `MockHttpRequest` class — minimal `HttpRequest`-compatible object for handler testing
- `makeRequest(options)` → unauthenticated request
- `makeAuthRequest(userId, email, options)` → request with valid JWT
- `invoke(handlerName, req)` → look up handler by name from setup.ts registry, invoke it

Added `apps/api/vitest.config.ts` and updated `vitest.workspace.ts` to include `apps/api`.

### 4. Blob split security tests — anonymous access ✅ DONE

`apps/api/src/__tests__/blob-split-security.test.ts` — 19 tests:

- **6 tests: Public blobs are anonymously readable.** For each public blob path
  (`rounds.json`, `pilots.json`, `clubs.json`, `sites.json`, `seasons.json`,
  `club-teams.json`), seeds data, HTTP GETs blob URL directly (no auth), asserts 200.
- **10 tests: Private blobs are NOT anonymously readable.** For each private blob path
  (`rounds/{id}.json`, `pilots/{id}.json`, `clubs/{id}.json`, `sites/{id}.json`,
  `config.json`, `users/{id}.json`, `user-index.json`, `auth/{id}.json`,
  `auth/tokens/{hash}.json`, `round-briefs/{id}.json`), seeds in private container,
  HTTP GETs blob URL, asserts 4xx.
- **2 tests: API serves private data to authenticated users.** Seeds round + user,
  calls `GET /api/rounds/{id}` via handler invoke with valid JWT, asserts 200.
  Also tests 404 for non-existent round.
- **1 test: API rejects unauthenticated access.** Calls handler without token, asserts 401.

### 5. Blob container routing tests ✅ DONE

`apps/api/src/__tests__/blob-container-routing.test.ts` — 3 tests:

- **Pilots**: `POST /api/pilots` → detail in private only, index in public, detail NOT in public.
- **Clubs**: `POST /api/clubs` → same pattern.
- **Sites**: `POST /api/sites` → same pattern.

### 6. Auth — registration + login

`apps/api/src/__tests__/auth-register-login.test.ts`

- Register a new user → returns 201, creates `users/{id}.json` + `auth/{id}.json`
  + updates `user-index.json` (all in private container).
- Register with duplicate email → returns 409.
- Register with weak password → returns 400.
- Login with correct credentials → returns 200 with `accessToken` + `refreshToken`.
- Login with wrong password → returns 401.
- Login with non-existent email → returns 401 (same error, no user enumeration).

### 7. Auth — token refresh + expiry

`apps/api/src/__tests__/auth-tokens.test.ts`

- Refresh with valid refresh token → returns new access token.
- Refresh with expired/invalid refresh token → returns 401.
- Access protected endpoint with expired access token → returns 401.
- Access protected endpoint with valid access token → returns 200.

### 8. Auth — role-based access control

`apps/api/src/__tests__/auth-rbac.test.ts`

Test matrix (key combinations, not exhaustive):

| Endpoint | Admin | RoundsCoord | Pilot | Unauthed |
|---|---|---|---|---|
| `GET /api/rounds/{id}` | 200 | 200 | 200 | 401 |
| `POST /api/rounds/{id}/...` (mutate) | 200 | 200 (own club) / 403 (other) | 403 | 401 |
| `GET /api/admin/users` | 200 | 403 | 403 | 401 |
| `POST /api/pilots` | 200 | 200 | 403 | 401 |
| `GET /api/me` | 200 | 200 | 200 | 401 |

### 9. Rounds — read + list

`apps/api/src/__tests__/rounds.test.ts`

- `GET /api/rounds` — returns round index (public, no auth required), correct shape.
- `GET /api/rounds/{id}` — authenticated, returns full round document.
- `GET /api/rounds/{id}` — unauthenticated, returns 401.
- `GET /api/rounds/{nonexistent}` — returns 404.

### 10. Rounds — mutations

`apps/api/src/__tests__/rounds-mutate.test.ts`

- Create round (Admin/RoundsCoord) → 201, round appears in index + private detail.
- Update round status transitions (Proposed → Confirmed → BriefComplete → Locked → Complete).
- RoundsCoord can only mutate rounds for their own club.
- Scoring is computed on Complete transition.

### 11. Pilots — CRUD

`apps/api/src/__tests__/pilots.test.ts`

- `GET /api/pilots` — public list, no auth.
- `GET /api/pilots/{id}` — authenticated, full pilot doc from private container.
- `POST /api/pilots` — create, verify private storage + public index update.
- `PUT /api/pilots/{id}` — update, verify private blob updated.

### 12. Clubs — CRUD

`apps/api/src/__tests__/clubs.test.ts`

- Same pattern as pilots: list (public), detail (authed), create, update.
- Verify `clubs/{id}.json` in private, `clubs.json` in public.

### 13. Sites — CRUD

`apps/api/src/__tests__/sites.test.ts`

- Same pattern. `sites/{id}.json` in private, `sites.json` in public.

### 14. Club teams — CRUD

`apps/api/src/__tests__/club-teams.test.ts`

- Create, update, delete club teams.
- Verify reads from private container for both `club-teams/{id}.json` and `clubs/{id}.json`.
- Index `club-teams.json` stays public.

### 15. Admin endpoints

`apps/api/src/__tests__/admin.test.ts`

- `GET /api/admin/users` — Admin only, returns user list.
- `PUT /api/admin/users/{id}/roles` — Admin only, updates roles.
- `GET /api/admin/config` — Admin only, reads from private container.
- `PUT /api/admin/config` — Admin only, writes to private container.
- All above return 403 for non-Admin roles.

### 16. Scoring — expand coverage

`packages/scoring/src/__tests__/scoring.test.ts` (extend existing file)

Additional tests:
- `scoreRound` with unknown wing class (not in wingFactors map) → uses 1.0 default.
- `scoreRound` with zero-distance flight → score is 0.
- `scoreRound` with empty teams array → no crash.
- `computeLeague` with multiple seasons of data.
- `computeLeague` `roundScores` map correctness (already partially covered, ensure
  all branches hit).

### 17. Recompute pure logic tests

`apps/api/src/__tests__/recompute.test.ts`

Extract and test the pure logic portions of `recompute.ts`:
- `buildSeasonResults()` — given round docs + pilot name map, verify output shape
  and ranking correctness.
- League recomputation — given a set of round docs, verify `seasons/{year}.json`
  and `results/{year}.json` contents.

Note: these may require refactoring `recompute.ts` to export the pure functions
separately, or testing through the API endpoint that triggers recomputation.

### 18. Web — `api.ts` client tests

`apps/web/src/__tests__/api.test.ts`

Install `msw` as a dev dependency. Tests:
- `api.get(path)` attaches `Authorization: Bearer <token>` from localStorage.
- `api.post(path, body)` sends JSON body with correct `Content-Type`.
- 401 response triggers token refresh, then retries original request.
- Refresh failure clears tokens from localStorage.
- `ApiError` has correct `.status` and `.message` properties.
- Requests without stored token omit `Authorization` header.

### 19. Web — `useAuth` hook tests

`apps/web/src/__tests__/useAuth.test.ts`

Install `@testing-library/react` as a dev dependency. Tests:
- `login(email, password)` stores tokens in localStorage, updates identity state.
- `logout()` clears tokens from localStorage, resets identity state.
- On mount, auto-refreshes if access token is near expiry.
- On mount, does nothing if no tokens stored.
- `isAuthenticated` reflects current token state.
- `hasRole(role)` checks identity roles correctly.

### 20. Web — `useBlob` hook tests

`apps/web/src/__tests__/useBlob.test.ts`

- Fetches from `VITE_BLOB_BASE_URL + path` on mount.
- Returns `{ data, loading, error, notFound }` lifecycle correctly.
- `notFound: true` when blob returns 404.
- `null` path skips fetch.
- Re-fetches when path changes.

### 21. GitHub Actions CI workflow

Create `.github/workflows/test.yml`:

```yaml
name: Test
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      azurite:
        image: mcr.microsoft.com/azure-storage/azurite
        ports:
          - 10000:10000
          - 10001:10001
          - 10002:10002
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: make build
      - run: npx vitest run --coverage
        env:
          BLOB_CONNECTION_STRING: "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IkvFpEgBm+Nwj4gEWH9A3RoLOHKvPVZLqGw==;BlobEndpoint=http://localhost:10000/devstoreaccount1;"
      - uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: coverage/
```

---

## Dependency Changes

### Already done
| Package | Where | Purpose |
|---|---|---|
| `vitest` 4.1.2 | root devDep | Test runner |
| `@vitest/coverage-v8` 4.1.2 | root devDep | Coverage reporting |

Removed from `packages/scoring`: `jest`, `ts-jest` (215 packages pruned).

### Still needed
| Package | Where | Purpose |
|---|---|---|
| `msw` | `apps/web` devDep | HTTP mocking for frontend tests |
| `@testing-library/react` | `apps/web` devDep | React hook/component testing |
| `@testing-library/jest-dom` | `apps/web` devDep | DOM assertion matchers |

---

## Estimated Effort

| Phase | Steps | Effort | Tests added |
|---|---|---|---|
| 1 — Foundation | 1-3 | ~~1 day~~ DONE | 0 (infrastructure) |
| 2 — Blob split security | 4-5 | ~~1 day~~ DONE | 22 |
| 3 — Auth flow | 6-8 | 1.5 days | ~20 |
| 4 — API endpoints | 9-15 | 2-3 days | ~40 |
| 5 — Scoring & recompute | 16-17 | 0.5 day | ~10 |
| 6 — Web hooks/lib | 18-20 | 1-1.5 days | ~20 |
| 7 — CI | 21 | 0.5 day | 0 (infrastructure) |
| **Total** | | **~8 days** | **~105 tests** |

---

## What This Plan Does NOT Cover

- **E2E / Playwright tests.** Full browser-based user journey tests are a separate
  future effort. The ROI is lower for this codebase size, and maintenance cost is high.
- **Load/performance testing.** The existing `perf-check.mjs` script covers this
  at a basic level. No changes planned.
- **Visual regression testing.** Not applicable for this admin-oriented SPA.
- **Migration script tests.** `scripts/migrate/migrate.mjs` is a one-time script
  that has already run. Not worth testing retroactively.
