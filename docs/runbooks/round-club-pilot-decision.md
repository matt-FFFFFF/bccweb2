# RoundClubPilot Migration Decision

**Date**: 2026-06-09
**Decider**: Matt White (project owner)
**Task**: Wave 4b, Task 32
**Decision**: Option (b) — redundant / discard with audit trail

---

## Legacy Table Shape

`BCCWeb.Models.RoundClubPilot` (Entity Framework model → SQL table `RoundClubPilots`):

| Column | EF Type | Required | Notes |
|---|---|---|---|
| ID | int | Yes | Primary key |
| Pilot | Pilot (nav) | Yes | FK to Pilots |
| Round | Round (nav) | Yes | FK to Rounds |
| Club | Club (nav) | Yes | FK to Clubs |
| PhoneNumber | string | Yes | PII — pilot phone at registration time |
| Pilot_Rating | PilotRating (nav) | Yes | Rating at registration time |
| WingClass | string | Yes | e.g. "EN B" |
| Manufacturer | Manufacturer (nav) | Yes | Wing manufacturer FK |
| Manufacturer_ID | int | Yes | FK shadow property |
| WingModel | string | Yes | Wing model name |
| WingColours | string | Yes | Wing colours |
| HelmetColour | string | Yes | Helmet colour |
| HarnessType | string | Yes | Harness type |
| HarnessColour | string | Yes | Harness colour |
| EmergencyContactName | string | Yes | PII |
| EmergencyPhoneNumber | string | Yes | PII |
| MedicalInfo | string | No | PII |

Note: no FK to `RoundTeam` or `RoundTeamPlace`. The record is entirely outside the team structure.

---

## Investigation Approach

### Source files inspected

- `BCCWeb/Models/RoundClubPilot.cs` — model fields above
- `BCCWeb/Controllers/RoundClubPilotsController.cs` — semantics analysis

### Controller semantics

The `Create` (GET) action at lines 39–63 of `RoundClubPilotsController.cs` redirects away when:

1. `isCurrentUserRegisteredInRoundOnSameDate` — pilot already in another round on that date
2. `isPilotAvailable` — pilot can follow the *team* path (`RoundTeamPilot/Create`)
3. Round is Locked, Complete, or Cancelled
4. `GetRoundClubPilotViewModel` returns null — pilot is already in the round via a team slot

The comment at line 46: *"This is needed to protect against user editing the
`...RoundTeamPilot/Create/id` url and getting here."* confirms these are mutually exclusive
registration paths.

`SetIsRegisteringInFirstRound` (lines 65–77) queries `RoundTeamPlaces` to count how many
team-slot rounds the pilot has completed this season. A count of zero means the pilot has
never been in a team slot — this is the primary population of `RoundClubPilot` registrants.

`CreateRoundClubPilot` (lines 423–453):
- Calls `AllocatePilotToClubForSeason` to assign the pilot to a club for the season
- Creates the `RoundClubPilot` row with safety/equipment snapshot
- No FK written to any `RoundTeam` or `RoundTeamPlace`

`DeleteRoundClubPilot` (lines 514–529) redirects to `rounds/editteams` after deletion — i.e.
the coordinator then manually assigns the pilot to a team slot. This confirms the intended
lifecycle: RoundClubPilot = "holding queue" pending coordinator assignment.

### Relationship to RoundTeamPilot

`RoundTeamPilot` is the record of a pilot assigned to a specific slot (`RoundTeamPlaces.PlaceInTeam`).
It is already migrated in `migrate.mjs` Step 8 as `rtp.*` joined through `RoundTeamPlaces`.

`RoundClubPilot` has no FK to any team table. A pilot in this table was either:
- **(a) Promoted**: later assigned to a team slot → now captured in `RoundTeamPilot` (already in Step 8)
- **(b) Not promoted**: never assigned → participated outside the scoring structure

Both cases mean the `RoundClubPilot` data is not needed in the new system.

---

## Decision

**Option (b): Redundant — discard with audit trail.**

### Rationale

1. **New model is team-centric.** The `Round` type in `packages/types` has no concept of
   non-team participants. All participation is through `teams[].pilots[]`. Adding a first-class
   `participants` blob would require new TypeScript types, new API endpoints, new UI components,
   and new operational workflows — disproportionate scope for a migration step.

2. **Safety data already migrated.** All pilot safety data (emergency contacts, medical info,
   equipment details) is captured in `pilots/{uuid}.json` (Step 7) from the `Pilots` table.
   `RoundClubPilot` holds a *snapshot* of that data at registration time, but since the round
   has already completed, this historical snapshot has no operational value in the new system.

3. **Promoted pilots already present.** Any `RoundClubPilot` who was assigned to a team slot
   has a corresponding `RoundTeamPilot` row that is already migrated with its full snapshot
   (Step 8). The `RoundClubPilot` row for such a pilot is a superseded pre-assignment copy.

4. **Surplus pilots are non-scoring.** Any `RoundClubPilot` who was never assigned to a team
   slot has no flights, no `PilotPoints`, and no contribution to the league. They are not in any
   `results/{year}.json` or `seasons/{year}.json` data.

5. **PII risk avoided.** Migrating phone numbers, emergency contacts, and medical snapshots to
   a new blob type would require: new PII scanner rules (T22), new GDPR erasure coverage, and
   new private-only enforcement. Not justified for historically irrelevant data.

6. **Task default.** Per task specification: *"DEFAULT decision when in doubt: Option (b)
   'redundant — discard with audit trail' — simpler, no UI changes, preserves audit trail via
   the count."*

### Impact analysis

| Area | Impact |
|---|---|
| Scoring / league | None — surplus pilots had no flights |
| Safety briefs | None — promoted pilots are in RoundTeamPilot snapshots |
| PII exposure | None — no new blobs written |
| Audit trail | Row count written to `.migration-state/discarded-counts.json` |
| Functional regression | None — feature does not exist in new app |
| Go-live risk | Low |

### What is lost

Historical equipment snapshots (wing, harness, helmet colours) at time of round registration,
for pilots who were never assigned to a team slot. Their *current* pilot profiles ARE migrated.
This is acceptable given the absence of a corresponding feature in the new application.

---

## Club Membership Enforcement (Shipped)

**Date added**: 2026-07-05

Both the coordinator/admin "add pilot" path and the pilot self-register path now hard-block any attempt to place a pilot into a team whose club does not match the pilot's club for the round's season. This is a **hard block for all roles — Admin included**. There is no override.

### Club resolution

Both paths resolve a pilot's season club via `pilotClubIdForSeason` in `apps/api/src/lib/pilotClub.ts`:

```
seasonClubs[seasonYear].clubId  (authoritative — season-club entry wins)
  ?? currentClub.id             (fallback — pilot's current club)
  ?? null                       (no club → blocked)
```

`ensureSeasonClubRecorded` (same file) records the season-club entry on a successful add, so the season club is locked in on first registration.

### Coordinator / Admin: addPilot

`POST /api/rounds/{id}/teams/{teamId}/pilots` (`apps/api/src/functions/teams.ts`)

| Condition | Status | Code |
|---|---|---|
| Round roster is frozen | `409` | `CONFLICT` |
| Pilot has no club for the season | `422` | `NO_CLUB_FOR_SEASON` |
| Pilot's season club ≠ team's club | `422` | `TEAM_CLUB_MISMATCH` |
| Season-club record written, re-check fails | `422` | `TEAM_CLUB_MISMATCH` |

The frozen-round check (`409 CONFLICT`) runs before the club checks. Both `NO_CLUB_FOR_SEASON` and `TEAM_CLUB_MISMATCH` use `422` here because a coordinator acting on behalf of someone else is supplying bad data, not fixing their own profile.

### Pilot self-register

`POST /api/rounds/{roundId}/register-self` (`apps/api/src/functions/roundRegistration.ts`)

| Condition | Status | Code |
|---|---|---|
| Round not open for registration | `409` | `REGISTRATION_CLOSED` |
| Pilot has no club for the season | `409` | `NO_CLUB_FOR_SEASON` |
| Pilot's club has no team in the round | `409` | `NO_TEAM_FOR_CLUB` |
| Explicit `teamId` doesn't belong to pilot's club | `422` | `TEAM_CLUB_MISMATCH` |

`NO_CLUB_FOR_SEASON` is `409` (not `422`) on this path because the caller is fixing their own profile state — they should update their club in their profile and try again.

### What coordinators see

The web "Add Pilot" picker already filters the pilot list to the team's club, so coordinators won't normally reach these errors through the UI. The API is the authoritative gate; these codes exist for direct API calls and future integrations.

### Operational notes

- A pilot who appears in `NO_CLUB_FOR_SEASON`: ask the pilot to set their club in their profile, or set it via the admin pilot-edit UI. Once set, the add will succeed.
- A `TEAM_CLUB_MISMATCH`: the pilot's season club is definitively wrong for this team. Either the pilot belongs to a different club's team, or their profile has the wrong club. Correct the profile first.
- Season clubs are immutable once recorded for a given year. If a pilot joined the wrong club, that requires an admin correction to their `pilot.seasonClubs` entry.

---

## Migration Implementation Summary

### `scripts/migrate/discarded-counts.mjs` (new)

Helper module providing `writeDiscardedCounts(counts, stateDir?)` and
`readDiscardedCounts(stateDir?)`. Writes atomically to
`.migration-state/discarded-counts.json` via tmp-rename. `stateDir` parameter enables
testing without touching the real state directory.

### `scripts/migrate/migrate.mjs` — Step 9b (added after Step 9: round-briefs)

```text
1. SELECT COUNT(*) AS cnt FROM RoundClubPilots
2. Log: "RoundClubPilot: {count} rows analyzed as redundant with RoundTeamPilot data — not migrated"
3. writeDiscardedCounts({ roundClubPilot: count })
4. No blobs written for these rows
```

### `scripts/migrate/reconcile.mjs` (updated)

Reads `.migration-state/discarded-counts.json` (if present) and includes a `discarded` field
in the reconciliation report JSON. Console output shows each discarded entity count.

### `apps/api/src/__tests__/migrate-roundclubpilot.test.ts` (new)

Vitest contract tests verifying:
- `discarded-counts.json` has the expected `{ roundClubPilot: number }` shape
- Reconcile report `discarded` field is populated from the state file
- No `rounds/*/participants.json` blobs are produced (Option b produces no participant blobs)
