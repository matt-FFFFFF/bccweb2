# @bccweb/api

## Running tests

Tests run on [Vitest](https://vitest.dev). Run the API tests with:

- `npm test` (from `apps/api`) — runs `vitest run`
- `make test` (from repo root) — runs the full Vitest workspace
- `npx vitest run path/to/file.test.ts` — single file

Prerequisite:

- Start Azurite first: `docker compose up azurite` (API tests create per-file
  Azurite containers and will fail without it).
