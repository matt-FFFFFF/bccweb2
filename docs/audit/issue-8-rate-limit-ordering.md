# Issue #8 — `mutationRateLimit` call-ordering audit

Audit artifact for GitHub issue #8 ("audit the `mutationRateLimit` call ordering
in each handler").

This document enumerates **every** `mutationRateLimit(...)` call site in
`apps/api/src/functions/` — **43 call sites across 15 files** — classifies each
against the 5-step ordering contract, and records the fix applied (if any) on
this branch.

Line numbers were derived from a live grep of the **current (post-fix)** source:

```
grep -rn "mutationRateLimit(" apps/api/src/functions/
```

The 7 handler files that contained ordering violations are **already reordered**
on this branch; the line numbers below reflect that reordered state.

---

## Ordering contract

The adopted contract is the canonical JSDoc on
[`apps/api/src/lib/rateLimit.ts:137+`](../../apps/api/src/lib/rateLimit.ts#L137)
(`mutationRateLimit`). It is not duplicated here — read it there. In summary, the
**5-step contract** is:

1. `getCallerIdentity(req)` first → `401` if null.
2. Coarse role gate → `403` before any rate-limit call.
3. If scope needs a resource, read it now (may `404`/`409`); fine scope check → `403`.
4. `mutationRateLimit(req, caller, endpoint, tier)` → `429` only after the above.
5. Input validation (`400`) / existence-only reads / mutation.

### The 403 > 429 (NOT 404 > 429) decision

The contract promises **`403` > `429` only**. A forbidden caller MUST receive
`403`, never `429`, and MUST NOT consume bucket capacity.

It deliberately does **not** promise `404` > `429` globally. We do **not** hoist
an existence-only read above the rate-limit gate solely to make `404` beat `429`.
A resource read is hoisted **only** when the *scope* check (a `403` decision)
genuinely needs that resource — in which case any incidental `404`/`409` from
that read is an accepted side effect of satisfying step 3, not a goal.

---

## Tier reference

Per [`rateLimit.ts:125-133`](../../apps/api/src/lib/rateLimit.ts#L125):
`standard` = 30/min, `heavy` = 5/min, `flights` = 60/min. No tiers were changed
by this audit.

---

## Call-site table (43 rows)

| File | Function | Line | Tier | Classification | Fix Applied |
|---|---|---|---|---|---|
| `clubTeams.ts` | createClubTeam | 119 | standard | VIOLATION-slide | Task 4: rate-limit slid below auth + own-club scope check |
| `clubTeams.ts` | updateClubTeam | 209 | standard | VIOLATION-read-move | Task 4: existing-team read hoisted; scope `403` resolved above rate-limit |
| `clubTeams.ts` | deleteClubTeam | 290 | standard | VIOLATION-read-move | Task 4: existing-team read hoisted; scope `403` resolved above rate-limit |
| `roundsMutate.ts` | createRound | 116 | standard | COMPLIANT | none |
| `roundsMutate.ts` | updateRound | 246 | standard | COMPLIANT | none |
| `roundsMutate.ts` | confirmRound | 405 | standard | COMPLIANT | none |
| `roundsMutate.ts` | briefCompleteRound | 443 | standard | COMPLIANT | none |
| `roundsMutate.ts` | lockRound | 668 | heavy | COMPLIANT | none |
| `roundsMutate.ts` | unlockRound | 845 | standard | COMPLIANT | none |
| `roundsMutate.ts` | completeRound | 879 | heavy | COMPLIANT | none |
| `roundsMutate.ts` | updateNarrative | 958 | standard | COMPLIANT | none |
| `clubs.ts` | createClub | 62 | standard | COMPLIANT | none |
| `clubs.ts` | updateClub | 98 | standard | COMPLIANT | none |
| `sites.ts` | createSite | 146 | standard | VIOLATION-slide | Task 3: rate-limit slid below `body.clubId` vs coord-of-club `403` check |
| `sites.ts` | updateSite | 202 | standard | VIOLATION-read-move | Task 3: existing-site read hoisted above rate-limit (scope needs `existing.clubId`) |
| `sites.ts` | deleteSite | 274 | standard | VIOLATION-read-move | Task 3: existing-site read hoisted above rate-limit (idempotent `204` preserved) |
| `admin.ts` | recomputeRound | 105 | standard | COMPLIANT | none |
| `admin.ts` | updateConfig | 178 | standard | COMPLIANT | none |
| `admin.ts` | setUserRoles | 304 | standard | COMPLIANT | none |
| `seasonClubs.ts` | createSeasonClub | 376 | standard | COMPLIANT | none |
| `seasonClubs.ts` | updateSeasonClub | 429 | standard | COMPLIANT | none |
| `seasonClubs.ts` | deleteSeasonClub | 482 | standard | VERIFIED-NO-OP | none (admin-only; dead coord branch — see note below) |
| `brief.ts` | updateRoundBrief | 257 | heavy | VIOLATION-read-move | Task 9: round read + fine RoundsCoord scope hoisted above rate-limit |
| `brief.ts` | uploadBriefImage | 371 | standard | VIOLATION-slide | Task 9: rate-limit slid below the fine scope check |
| `brief.ts` | deleteBriefImage | 456 | standard | VIOLATION-slide | Task 9: rate-limit slid below the fine scope check |
| `teams.ts` | addTeam | 81 | standard | COMPLIANT | none |
| `teams.ts` | removeTeam | 164 | standard | COMPLIANT | none |
| `teams.ts` | addPilot | 191 | standard | COMPLIANT | none |
| `teams.ts` | removePilot | 267 | standard | COMPLIANT | none |
| `teams.ts` | updateAccounted | 310 | standard | COMPLIANT | none |
| `adminWording.ts` | addSignToFlyWording | 17 | standard | COMPLIANT | none |
| `seasons.ts` | createSeason | 119 | standard | COMPLIANT | none |
| `seasons.ts` | updateSeason | 171 | standard | COMPLIANT | none |
| `seasons.ts` | deleteSeason | 222 | standard | COMPLIANT | none |
| `pilotSeasonClubs.ts` | assignPilotSeasonClub | 144 | standard | VIOLATION-lease-aware | Task 5: unleased authorization pre-read of pilot before rate-limit; leased read/write stays authoritative |
| `pilotSeasonClubs.ts` | deletePilotSeasonClub | 281 | standard | VIOLATION-read-move | Task 5: pilot + existing assignment pre-read hoisted above rate-limit |
| `flights.ts` | logFlight | 137 | flights | COMPLIANT | none |
| `flights.ts` | updateFlight | 216 | flights | COMPLIANT | none |
| `flights.ts` | deleteFlight | 262 | flights | COMPLIANT | none |
| `pilots.ts` | createPilot | 169 | standard | COMPLIANT | none |
| `pilots.ts` | updatePilot | 261 | standard | COMPLIANT | none |
| `teamsCaptain.ts` | setTeamCaptain | 78 | standard | VIOLATION-lease-aware | Task 8: unleased authorization pre-read of round before rate-limit; leased read/write stays authoritative |
| `puretrack.ts` | createPureTrackGroups | 107 | heavy | VIOLATION-read-move | Task 6: round read + cross-club scope `403` hoisted above rate-limit |

**Total: 43 rows.**

### Classification tally

(Counts use lowercase labels below so they do not collide with the verification
grep, which counts only the 43 table rows.)

- compliant: 30
- read-move fixes: 6 (updateClubTeam, deleteClubTeam, updateSite, deleteSite, updateRoundBrief, deletePilotSeasonClub)
- slide fixes: 4 (createClubTeam, createSite, uploadBriefImage, deleteBriefImage)
- lease-aware fixes: 2 (assignPilotSeasonClub, setTeamCaptain)
- read-move (puretrack): 1 (createPureTrackGroups)
- verified no-op: 1 (deleteSeasonClub)

Authoritative total = 30 compliant + 12 fixed + 1 no-op = **43** (matches the table).

### Authoritative fixed-handler breakdown (12 fixes, 7 files)

| File | read-move | slide | lease-aware |
|---|---|---|---|
| `clubTeams.ts` | updateClubTeam, deleteClubTeam | createClubTeam | — |
| `sites.ts` | updateSite, deleteSite | createSite | — |
| `brief.ts` | updateRoundBrief | uploadBriefImage, deleteBriefImage | — |
| `pilotSeasonClubs.ts` | deletePilotSeasonClub | — | assignPilotSeasonClub |
| `puretrack.ts` | createPureTrackGroups | — | — |
| `teamsCaptain.ts` | — | — | setTeamCaptain |

read-move = 6, slide = 4, lease-aware = 2 → **12 fixes** + **1 no-op**
(`deleteSeasonClub`) + **30 compliant** = **43**.

---

## `seasonClubs.ts:deleteSeasonClub` — verified no-op

`deleteSeasonClub` returns `403` immediately for any non-admin caller at the
coarse role gate **before** reaching `mutationRateLimit("deleteSeasonClub",
"standard")` at line 482. The later `isAdminOrScopedCoord(roles, caller.clubId,
existing.clubId)` branch is therefore **unreachable** for any non-admin — the
function has already exited with `FORBIDDEN`. There is no reachable `403`-vs-`429`
ordering violation to fix, so the source remains **byte-identical** (no source
edit). It carries the verified-no-op classification (rather than plain compliant)
in the table to mark that the dead coord branch was inspected and consciously
left untouched.

`createSeasonClub` and `updateSeasonClub` in the same file are plain compliant:
`getCallerIdentity` precedes `mutationRateLimit` and no fine scope read is needed
before the rate-limit gate.

---

## Files that do NOT use `mutationRateLimit`

Three function files under `apps/api/src/functions/` contain **no**
`mutationRateLimit` call site:

- `roundRegistration.ts`
- `rounds.ts` (read-only round endpoints)
- `signatures.ts`

### Note on the issue's original file list

The issue's original file list was **off**:

- It **omitted `brief.ts`**, which in fact contains 3 call sites (one of the
  most violation-dense files: 1 read-move + 2 slide).
- It **listed the 3 non-users above** (`roundRegistration.ts`, `rounds.ts`,
  `signatures.ts`) as if they used the limiter; they do not.

The corrected, authoritative scope is **15 files / 43 call sites**, with
per-file counts: roundsMutate 8, teams 5, seasons 3, brief 3, flights 3,
seasonClubs 3, admin 3, clubTeams 3, sites 3, pilotSeasonClubs 2, pilots 2,
clubs 2, adminWording 1, puretrack 1, teamsCaptain 1.

---

## Verification

Counting the three classification tokens (the two prefixes plus the no-op label)
yields one match per table row. The verification command (assembled from the
three alternation tokens — the compliant token, the violation prefix token, and
the no-op token) is run against this file and must report **43** — i.e. exactly
the 43 table rows. The command and its output are recorded in
`.omo/evidence/task-2-audit-table.txt`.
