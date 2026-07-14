# packages/schemas — blob schemas (zod/v4)

One schema module per blob family; barrel-exported from [`src/index.ts`](src/index.ts).
Reads/writes go through `readJson`/`writeJson`/`writePrivateJson` in
[`apps/api/src/lib/blobJson.ts`](../../apps/api/src/lib/blobJson.ts). See root
[AGENTS.md](../../AGENTS.md) for the monorepo build DAG.

## Schema modes and break-glass

- **`BLOB_SCHEMA_MODE`** (Function App env): `observe` (default) heals bad shapes in
  memory and emits telemetry only; `enforce` strips dead keys on write via `.strip()`.
  Toggling is an app-setting change, no redeploy — see `docs/runbooks/alerts.md`.
- **WingClass break-glass**: adding a `WingClass` requires, in order, types → schema →
  API deploy → admin UI emitting the new key. Reversing that order means `enforce` mode
  rejects or strips the field.
- **`DATA_SHAPE_INVALID`**: server-side data-invariant violation surfaced by
  `apps/api/src/lib/http.ts`. Body is `{error, path, schema}`, never field values.
- Full container/queue architecture:
  [docs/architecture/storage-and-queues.md](../../docs/architecture/storage-and-queues.md).

## Authoring pattern

```ts
import * as z from "zod/v4";
import type { Foo } from "@bccweb/types";
export const FooSchema = z.object({ … }).strip();   // or z.preprocess(...) / .transform(...)
FooSchema satisfies z.ZodType<Foo>;                  // keep schema ⇄ type in lockstep
```

- Library is **`zod/v4`** (not classic `zod`).
- Healing helpers in [`src/helpers.ts`](src/helpers.ts): `healed()`, `lenientOptional()`,
  `healingArray()`, `normalizeEnum()`. Use these instead of bare optionals so bad blobs heal
  in `observe` mode rather than throwing.
- `.strip()` drops unknown keys (what `enforce` relies on). Identity fields hard-fail.

## Module → blob family

| Module | Family |
|--------|--------|
| `brief.ts` | round brief JSON + version history + team/pilot entries |
| `config.ts` | config blob |
| `club.ts` / `clubTeam.ts` | clubs / club-teams (+ summaries) |
| `pilot.ts` | pilots (+ summaries; PII fields private-only) |
| `round.ts` | rounds (+ summaries; nested teams/flights/slots) |
| `season.ts` | seasons (+ summaries; league table) |
| `seasonClub.ts` / `site.ts` / `puretrack.ts` | season-clubs / sites / PureTrack groups |
| `signToFly.ts` | sign-to-fly wording + signature ledger |
| `user.ts` | users + auth credentials |

## Tests (`src/__tests__/`)

One test per module. They verify: identity fields hard-fail, unknown keys strip, defaults
fill, legacy aliases normalize, corrupted nested arrays/items heal, transforms preserve shape,
and private fields stay present only where intended. Add a case to the matching test when you
touch a schema.

## Gotchas

- `composite: true` + project refs → build `packages/schemas` before api/web typecheck
  (`make build`), or web tests alias to `src` and won't catch a stale build.
- A new field must land here **before** API writes it in `enforce` mode (else it's stripped).
- API JSON normally uses schema helpers; justified raw lease/index operations must document
  their exception at the call site. `bootstrapAdmin` is the sole test-fixture exception.
