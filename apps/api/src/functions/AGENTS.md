# apps/api/src/functions — HTTP handler modules

Each file self-registers one or more `app.http(...)` handlers at the **bottom** of
the file. **A new file here is DEAD until imported in [`../index.ts`](../index.ts).**
See root [AGENTS.md](../../../../AGENTS.md) for the module list, roles, and env.

## Handler shape (copy `teamsCaptain.ts` / `me.ts`)

1. `getCallerIdentity(req)` first → `unauthorizedResponse()` / `forbiddenResponse()` on fail.
2. `mutationRateLimit(...)` before any write.
3. Parse body: typed cast OR zod `safeParse`. Validate route params/required fields early.
4. Read/write blobs via **schema helpers** (`readJson`/`writeJson`/`writePrivateJson`),
   never raw JSON except non-JSON artifacts (PDF/image/lock).
5. Return `{ status, jsonBody }`. Wrap the handler in `withErrorHandler(...)`.

## Errors

- Throw `HttpError(status, code, detail?)` for expected failures → normalized to
  `{ error, code, requestId, detail? }` by `withErrorHandler` ([../lib/http.ts](../lib/http.ts)).
- `BlobShapeError` → `500 { error:"DATA_SHAPE_INVALID", path, schema }` (no field values).
- Local validation may still `return` an explicit `409/400` jsonBody (see `roundsMutate.ts`).

## Mutations + leases

- Private read-modify-write → `withPrivateLease(...)`; long work → `withPrivateLeaseRenewing(...)`.
- Public blob RMW → `withLease(...)`. Keep PDF/email/PureTrack work **outside** the lease.
- Round finalize MUST `updateRoundsIndex(...)`; `completeRound` then fires
  `recomputeSeason(year)` best-effort *after* the response.
- `seasonClubs.ts` uses a `.lock` sentinel + renewing lease for multi-blob mutations.

## File map (non-obvious)

| File | Why it's big / special |
|------|------------------------|
| `roundsMutate.ts` (~1000) | 6 endpoints: create/update/transition/lock/unlock/complete + brief/PureTrack/PDF/email helpers; state machine ~L351-390 |
| `teams.ts` | team + pilot slot management; `addPilot` hard-blocks wrong/absent season club (`422 TEAM_CLUB_MISMATCH` / `422 NO_CLUB_FOR_SEASON`) — no Admin override; see `docs/runbooks/round-club-pilot-decision.md` |
| `authFunctions.ts` (~629) | register/verify/resend/login/refresh/forgot/reset + "silent OK" anti-enumeration responses |
| `admin.ts` | config/user admin; `runConfigRmw(...)` + lease-conflict translation |
| `brief.ts` | invalidates sign-to-fly on material brief change, regenerates PDF outside lease |
| `meProfile.ts` | self-service create/link (pilot ↔ user index) |

## New file checklist

- [ ] Import it in [`../index.ts`](../index.ts).
- [ ] Bottom-of-file `app.http(...)` registration, existing comment style.
- [ ] Use `withErrorHandler` + shared response shape — do NOT invent a new error format.
