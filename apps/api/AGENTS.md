# apps/api — Azure Functions v4 API

Node 24, ESM, TypeScript. Entry: [`src/index.ts`](src/index.ts) imports every
self-registering function entry module; helper modules are imported by their owner.
**A new entry module is dead unless added to `src/index.ts`.** See root
[AGENTS.md](../../AGENTS.md) for the monorepo build DAG and storage/queue architecture
(also in [docs/architecture/storage-and-queues.md](../../docs/architecture/storage-and-queues.md)).

## TypeScript: NodeNext import rule

`module: NodeNext` → every relative import MUST end in `.js`
(`import x from "./lib/blob.js"`), even though the source file is `.ts`. This is enforced
by the compiler, not a lint rule — a missing extension fails typecheck, not lint.

## Module map

`health`, `me`, `meProfile`, `rounds`, `roundsMutate`, `seasons`, `pilots`, `clubs`,
`sites`, `manufacturers`, `teams`, `flights`, `igc`, `manualFlight`, `rescoreRound`,
`admin`, `adminWording`, `brief`, `puretrack`, `authFunctions`, `signatures`,
`roundRegistration`, `clubTeams`, `seasonClubs`, `pilotSeasonClubs`, `teamsCaptain` are
HTTP handlers. See
[`src/functions/AGENTS.md`](src/functions/AGENTS.md) for handler conventions and the
non-obvious file map.

Four queue-trigger modules (see the architecture doc for the flows they drive):

- `briefPdf` — `round-brief-pdf` + `-poison` (first non-HTTP triggers in the codebase).
- `signaturesReflect` — `signtofly-reflect` + `-poison`.
- `rescoreWorker` — **single** `app.storageQueue(...)` for `rescore-jobs` only; unlike the
  others it does NOT register a poison-queue consumer, because job failures are recorded
  on the job status blob rather than dead-lettered.
- `puretrackGroups` — `round-puretrack-group` + `-poison`, like `briefPdf`/`signaturesReflect`.

Lib helpers live in [`src/lib/AGENTS.md`](src/lib/AGENTS.md): `blob`, `blobJson`, `auth` +
`authHelpers`, `roundAuth`, `accountMutation`, `email`, `http`, `clientIp`, `pdf`,
`rateLimit`, `recompute`, `puretrack`, `teamCaptain`, `briefPdf`, `queue`, `telemetry` +
`telemetryRedactor`, `signTofly/*`.

## Auth

Bespoke HS256 JWT (`JWT_SECRET` env, ≥32 chars). Access token 1h, refresh 30d. Roles
`Admin`, `RoundsCoord`, `Pilot`. `getCallerIdentity(req)` returns
`CallerIdentity | null`; `RoundsCoord` users have a `clubId` scoping their writes.

## Env

See [local.settings.example.json](local.settings.example.json): `AzureWebJobsStorage`,
`BLOB_CONNECTION_STRING`,
`BLOB_CONTAINER_NAME` (`data`), `BLOB_PRIVATE_CONTAINER_NAME` (`data-private`),
`JWT_SECRET`, `ACS_CONNECTION_STRING`, `ACS_SENDER_ADDRESS`, `ROUND_BRIEF_EMAILS`,
`PURETRACK_*`. Copy the example → `local.settings.json`.

## Testing — gotchas

Vitest ([vitest.config.ts](vitest.config.ts)):

- **Per-file Azurite containers**: each test file gets its own `test-data-<rand>` /
  `test-priv-<rand>`, deleted in `afterAll`; stale `test-*` (>1h) are swept from
  `127.0.0.1` only. Isolation must NOT rely on fresh-worker-per-file —
  `helpers/setup.ts` calls `resetBlobSingletons()` before container creation (contains
  blast radius: a file crashing mid-lease can't stall the next behind a 30s lease
  timeout).
- `@azure/functions` is **mocked** — `app.http()` populates a registry; tests invoke via
  `getRegisteredHandler(name)` (queue triggers via `getRegisteredQueueHandler(name)`).
  `email`, `pdf`, `puretrack` are mocked too. `helpers/seed.ts` prefers handlers but uses
  raw fixture access for bootstrap, controlled ID/team/state overrides, deliberately
  corrupt negative fixtures, and assertion reads; its banner is the allowlist.
- `fileParallelism: false` + `sequence.concurrent: false` — sequential for stable blob
  state.
- `TEST_BCRYPT_COST` honored only when `NODE_ENV === "test"`; else cost stays 12.
- 3 heavy tests excluded (`blob`, `puretrack`, `telemetry.integration`) — reasons inline;
  run via `make test-heavy`.
- PureTrack live-API tests are opt-in (`make test-integration`, needs `apps/api/.env` +
  network); self-skip without credentials, excluded from CI. See
  [README.md](README.md#puretrack-integration-tests-opt-in-live-api).

## New function module checklist

- [ ] Entry module: import it in `src/index.ts` and self-register.
- [ ] Helper module: import it from its owning entry module; do not self-register.
- [ ] Follow the handler shape / registration style in
      [`src/functions/AGENTS.md`](src/functions/AGENTS.md).
- [ ] If it's Admin-managed data, ship the operator UI in the same PR (root
      AGENTS.md's Feature Completeness Rule).
