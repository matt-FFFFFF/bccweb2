# Canned migration fixture

Synthetic legacy BCCWeb schema + data for the migration smoke test
(`scripts/migrate/__tests__/migration.smoke.test.mjs`).

## Contents

- `schema.sql` — `CREATE TABLE` definitions for every legacy table the
  migration reads (or counts).
- `seed.sql` — `INSERT` statements: 2–3 rows per entity, covering both
  the happy path (Complete round with flights + brief) and minimal
  edges (Confirmed round with no teams, pilot with null person fields,
  manufacturer with null website, site with null status).

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
