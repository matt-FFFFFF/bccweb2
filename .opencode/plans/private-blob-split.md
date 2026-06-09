# Private Blob Split Plan

## Problem

Single `data` container with `publicAccess = "Blob"` means every blob URL is
anonymously readable, including credentials, PII, and pilot safety data. The API
enforces role-based auth on its endpoints, but anyone who knows a blob URL bypasses
it entirely.

## Solution

Split into two containers:

- **`data`** — public, `publicAccess = "Blob"`, SPA reads directly (unchanged)
- **`data-private`** — private, `publicAccess = "None"`, API access only

---

## Phase Progress

### Phase 1 — Foundation (DONE)
Steps 1, 2, 3, 22: Infrastructure (Terraform), blob.ts private helpers, init-storage script.
Build verified passing.

### Phase 2 — Auth & lib migration (DONE)
Steps 15, 17, 18: `authFunctions.ts`, `auth.ts`, `authHelpers.ts` — route auth/user blobs to private.
Build verified passing.

### Phase 3 — API function migration (DONE)
Steps 4-14, 16: Migrated all API function files (`rounds`, `roundsMutate`, `pilots`, `clubs`,
`clubTeams`, `sites`, `teams`, `flights`, `puretrack`, `admin`, `brief`) to private blob access.
Build verified passing.

### Phase 4 — Recompute (DONE)
Step 19: `recompute.ts` — reads private, writes public.
Build verified passing.

### Phase 5 — Web SPA changes (DONE)
Steps 20-21: `RoundDetail.tsx`, `RoundManage.tsx` — replace `useBlob` with `api.get`.
Build verified passing.

### Phase 6 — Scripts (DONE)
Steps 23-25: `admin-users.mjs`, `migrate.mjs`, `perf-check.mjs`.
Build verified passing.

---

## Container Assignment

### Public (`data`) — SPA reads directly via `useBlob` / `VITE_BLOB_BASE_URL`

| Blob path |
|---|
| `rounds.json` |
| `seasons.json` |
| `seasons/{year}.json` |
| `results/{year}.json` |
| `pilots.json` |
| `clubs.json` |
| `sites.json` |
| `club-teams.json` |

### Private (`data-private`) — API only

| Blob path | Reason |
|---|---|
| `rounds/{uuid}.json` | Full round details — pilot lists, scores, flight data |
| `pilots/{uuid}.json` | Medical info, emergency contacts, phone numbers |
| `clubs/{uuid}.json` | Full club records |
| `club-teams/{uuid}.json` | Team membership details |
| `sites/{uuid}.json` | Full site records |
| `config.json` | Admin configuration |
| `users/{uuid}.json` | PII + roles |
| `user-index.json` | Email → user ID mapping |
| `auth/{uuid}.json` | Password hashes |
| `auth/tokens/{hash}.json` | Short-lived auth tokens |
| `round-briefs/{uuid}.json` | Pilot safety brief data |
| `round-briefs/{uuid}.pdf` | Pilot safety brief PDF |
| `manufacturers.json` + `manufacturers/{uuid}.json` | Migration artefacts |
| `pilot-ratings.json` | Migration artefact |
| `seasons/{year}.json` (detail writes via recompute) | Written privately, served publicly |

---

## Changes Required

### 1. `iac/storage.tf` ✅ DONE

- Add `azapi_resource "storage_container_data_private"` with `publicAccess = "None"`
- Keep existing `data` container and `allowBlobPublicAccess = true` on the account

### 2. `iac/functions.tf` ✅ DONE

- Add `BLOB_PRIVATE_CONTAINER_NAME = "data-private"` to Function App app settings

### 3. `apps/api/src/lib/blob.ts` ✅ DONE

Add a second container client singleton and mirror all exports with `Private` variants:

```
getPrivateBlobClient(path)
getPrivateBlockBlobClient(path)
writePrivateBlob(path, data, leaseId?)
withPrivateLease(path, fn)
```

Existing public exports (`getBlobClient`, `getBlockBlobClient`, `writeBlob`, `withLease`)
remain unchanged — callers of public blobs need no edits.

### 4. `apps/api/src/functions/rounds.ts` ✅ DONE

- Route `rounds/{id}.json` read → `getPrivateBlobClient`
- Add `getCallerIdentity(req)` check to `GET /api/rounds/:id`; return `401` if not
  authenticated. `GET /api/rounds` (index) stays open and reads from public container.

### 5. `apps/api/src/functions/roundsMutate.ts` ✅ DONE

Route to private container:
- `rounds/{id}.json` — all reads, writes, leases
- `pilots/{id}.json` — reads
- `round-briefs/{id}.json` — write
- `round-briefs/{id}.pdf` — upload
- `config.json` — read
- `sites/{id}.json` — reads
- `clubs/{id}.json` — reads
- `seasons/{year}.json` — reads, writes, leases

### 6. `apps/api/src/functions/seasons.ts` ✅ DONE (no change needed)

Reads `seasons/{year}.json` and `results/{year}.json` — both public, no change.

### 7. `apps/api/src/functions/pilots.ts` ✅ DONE

- `pilots/{id}.json` reads/writes → private
- `pilots.json` (index) → stays public

### 8. `apps/api/src/functions/clubs.ts` ✅ DONE

- `clubs/{id}.json` reads/writes → private
- `clubs.json` (index) → stays public

### 9. `apps/api/src/functions/clubTeams.ts` ✅ DONE

- `club-teams/{id}.json` reads/writes/deletes → private
- `clubs/{id}.json` read → private
- `club-teams.json` (index) → stays public

### 10. `apps/api/src/functions/sites.ts` ✅ DONE

- `sites/{id}.json` reads/writes → private
- `sites.json` (index) → stays public

### 11. `apps/api/src/functions/teams.ts` ✅ DONE

- `rounds/{id}.json` reads/writes/leases → private
- `clubs/{id}.json` read → private
- `pilots/{id}.json` read → private

### 12. `apps/api/src/functions/flights.ts` ✅ DONE

- `rounds/{id}.json` reads/writes/leases → private

### 13. `apps/api/src/functions/puretrack.ts` ✅ DONE

- `rounds/{id}.json` reads/writes/leases → private
- `pilots/{id}.json` read → private

### 14. `apps/api/src/functions/admin.ts` ✅ DONE

- `rounds/{id}.json` read → private
- `config.json` reads/writes → private
- `users/{id}.json` reads/writes → private
- `user-index.json` read → private

### 15. `apps/api/src/functions/authFunctions.ts` ✅ DONE

- `auth/{id}.json` reads/writes → private
- `users/{id}.json` read → private

### 16. `apps/api/src/functions/brief.ts` ✅ DONE

- `round-briefs/{id}.json` read → private
- `round-briefs/{id}.pdf` stream download → private

### 17. `apps/api/src/lib/auth.ts` ✅ DONE

- `users/{id}.json` reads/writes → private
- `user-index.json` reads/writes → private

### 18. `apps/api/src/lib/authHelpers.ts` ✅ DONE

- `auth/tokens/{hash}.json` reads/writes/deletes → private
- `user-index.json` read → private

### 19. `apps/api/src/lib/recompute.ts` ✅ DONE

Straddles both containers:
- `rounds/{id}.json` reads → private
- `seasons/{year}.json` reads/writes/leases → **public** (SPA reads directly)
- `results/{year}.json` write → **public**
- `pilots.json` read → **public** (index)

### 20. `apps/web/src/pages/rounds/RoundDetail.tsx` ✅ DONE

Replace `useBlob<Round>(id ? \`rounds/${id}.json\` : null)` with `api.get<Round>(\`/api/rounds/${id}\`)`.
Route is already behind `RequireAuth` — no router change needed.

### 21. `apps/web/src/pages/rounds/RoundManage.tsx` ✅ DONE

Replace `useBlob<Round>(id ? \`rounds/${id}.json\` : null)` with `api.get<Round>(\`/api/rounds/${id}\`)`.
Also update the post-mutation reload: since the page already calls `api.put/post` for
mutations, re-fetch via API instead of the current blob path key trick.

### 22. `scripts/init-storage.mjs` ✅ DONE

Add `data-private` to the `CONTAINERS` array:

```js
const CONTAINERS = [
  { name: "data",         publicAccess: "blob" },
  { name: "data-private", publicAccess: undefined },  // private
];
```

The existing `createContainer` function already handles `publicAccess: undefined`
correctly (omits the `x-ms-blob-public-access` header).

### 23. `scripts/admin-users.mjs` ✅ DONE

Add a private container client using `BLOB_PRIVATE_CONTAINER_NAME` env var
(default `"data-private"`). Route all three paths to the private container:
- `user-index.json`
- `users/{id}.json`
- `auth/{id}.json`

The public container is not used by this script at all.

### 24. `scripts/migrate/migrate.mjs` ✅ DONE

Add a `privateContainerClient` and `uploadPrivateBlob(path, obj)` helper.
Route each `uploadBlob` call:

| Stays public (`uploadBlob`) | Moves private (`uploadPrivateBlob`) |
|---|---|
| `rounds.json` | `rounds/{id}.json` |
| `pilots.json` | `pilots/{id}.json` |
| `clubs.json` | `clubs/{id}.json` |
| `sites.json` | `sites/{id}.json` |
| `club-teams.json` | `club-teams/{id}.json` |
| `seasons.json` | `config.json` |
| `seasons/{year}.json` | `manufacturers.json` + `manufacturers/{id}.json` |
| `results/{year}.json` | `pilot-ratings.json` |
| | `round-briefs/{uuid}.json` |

### 25. `scripts/perf-check.mjs` ✅ DONE

Remove `config.json` from blob direct-read targets — it moves to private and is no
longer anonymously accessible.

---

## What Does NOT Change

- Router — `RoundDetail` and `RoundManage` already behind `RequireAuth`
- All `useBlob` calls for public paths
- `GET /api/rounds` (index endpoint) — stays open, reads public container
- Web SPA `blobClient.ts` / `useBlob` hook
- CORS config on the storage account

---

## Notes

- **`recompute.ts` straddles both containers**: reads private blobs (`rounds/{id}.json`)
  and writes public blobs (`seasons/{year}.json`, `results/{year}.json`). Needs both
  container clients imported.
- **No data migration needed for dev**: Azurite is ephemeral. Production migration
  (copying blobs between containers) is a separate ops step.
- **`seasons/{year}.json` is public** even though the API writes to it — the SPA reads
  league tables directly. The API writes to the public container for this path.
