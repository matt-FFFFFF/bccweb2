# Canned migration fixture

Synthetic legacy BCCWeb schema + data for the migration smoke test
(`scripts/migrate/__tests__/migration.smoke.test.mjs`).

## Contents

- `schema.sql` — `CREATE TABLE` definitions for every legacy table the
  migration reads (or counts).
- `seed.sql` — `INSERT` statements: 2–3 rows per entity, plus targeted
  drift-healing edges. Counts: 6 statuses, 3 manufacturers, 3 pilot
  ratings, 3 clubs, 3 frequencies, 3 sites, 2 seasons, 3 season clubs,
  3 season-club frequencies, 3 people, 3 users, 3 pilots, 3 pilot-season
  clubs, 3 pilot-club rows, 3 teams, 3 rounds, 3 round teams,
  3 round-team pilots, 9 round-team places, 3 flights, 1 round brief, and
  2 round-club-pilot rows.
- Happy path: one Complete round with flights, a dateless brief, a briefer
  with the legacy `Club Coach` label, and an organising-club season frequency
  that yields `frequencyMhz`.
- Drift edges: a Deleted/siteless round, a blank first-name person, a
  clubless team, legacy SignToFly rows, `EN_B` wing-class alias,
  `puretrack`/`manual` scoring aliases, `Advanced Pilot` plus `CP` pilot
  rating aliases, and one season club with `AcceptTsCs = 0`.

## PII safety

All seed data is synthetic:

- Pilot/person names use generic identifiers (`Synthetic Alpha`, etc.).
- Email addresses use the IANA-reserved `.test` TLD (`alpha@example.test`).
- Phone numbers use the UK reserved testing range (`+44 1632 xxx xxx`).
- No medical info, no real club/site names.

This fixture is committed to the repository and may run in CI.

## Format

Plain `.sql` text files (not BACPAC) so they:

1. Diff cleanly in code review.
2. Load on any TDS-speaking SQL Server (full SQL Server, SQL Express,
   Azure SQL Edge — used by the smoke test on Apple Silicon).
3. Stay portable across host architectures (BACPAC needs SqlPackage
   which is not consistently available on arm64).
