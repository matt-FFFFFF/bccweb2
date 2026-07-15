# Privacy Runbook

Source of truth for the BCC PII redaction policy. All changes to this file require
a pull-request review by the data controller (project owner: Matt White).

## PII Redaction List

The canonical list lives in `scripts/lib/pii.mjs` (`PII_FIELDS` export).
The TypeScript port in `apps/api/src/lib/telemetryRedactor.ts` maintains an
identical copy — both files must be updated together.

Current fields:

| Field | Category |
|---|---|
| `email` | Contact |
| `password` | Credentials |
| `passwordHash` | Credentials |
| `phoneNumber` | Contact |
| `bhpaNumber` | Identity |
| `medicalInfo` | Health |
| `emergencyContactName` | Contact |
| `emergencyPhoneNumber` | Contact |
| `userAgent` | Fingerprinting |
| `ip` | Fingerprinting |
| `Authorization` | Auth tokens |
| `JWT` | Auth tokens |
| `jwt` | Auth tokens |
| `accessToken` | Auth tokens |
| `refreshToken` | Auth tokens |
| `verifyToken` | Auth tokens |
| `resetToken` | Auth tokens |
| `helmetColour` | Equipment |
| `harnessType` | Equipment |
| `harnessColour` | Equipment |
| `wingModel` | Equipment |
| `wingClass` | Equipment |
| `wingColours` | Equipment |

## Exception Process

Any whitelist exception (a PII field permitted in a specific public location)
requires:

1. A written justification explaining the legal basis (consent, legitimate interest,
   or legal obligation under UK GDPR Article 6).
2. Named approver (must be the data controller: Matt White).
3. A new entry in the table below committed to this file via PR.

### Current Exceptions

| Field | Location | Justification | Approved by | Date |
|---|---|---|---|---|
| `wingClass` | `results/{year}.json` — `teamResults[].pilots[].wingClass` | EN A/B/C/D is a competition scoring category used to compute the wing-factor multiplier. It is part of the official public competition record (RoundResult interface) and does not identify an individual — it is equivalent to a sport classification. Required for public scoring transparency. | Matt White | 2026-06-09 |

If adding a new exception, append a row with the format:

| Field | Location | Justification | Approved by | Date |
|---|---|---|---|---|

## How to Run the Scanner Locally

Requires Azurite running (`docker compose up azurite`) and containers initialised:

```sh
node scripts/init-storage.mjs

# Scan against local Azurite (default):
node scripts/privacy-scan.mjs

# Scan against a specific connection string:
node scripts/privacy-scan.mjs --source "DefaultEndpointsProtocol=https;..."

# Include bundle regex scan (add fixture emails/phones from test data):
node scripts/privacy-scan.mjs --bundle-patterns "test@example\.com,\+447\d+"
```

The scanner exits 0 on a clean pass, 1 if any violation is found.
Output lines are prefixed `[PASS]`, `[SKIP]`, or `[FAIL]`.

## How to Add a New Redaction Field

1. Add the field name to `PII_FIELDS` in `scripts/lib/pii.mjs`.
2. Add the identical field name to `PII_FIELDS` in `apps/api/src/lib/telemetryRedactor.ts`.
3. Add a row to the table above.
4. Run `node scripts/privacy-scan.mjs` and verify it still exits 0 (the new field
   should not appear in any public blob).
5. Run `npm test` from the workspace root to verify the telemetry redactor tests pass.
6. Commit both files together in the same PR.

## CI Integration

The privacy scanner runs automatically on every PR and push to `main` via
`.github/workflows/privacy-scan.yml`. It spins up Azurite as a service container,
seeds known-good test blobs, and runs `node scripts/privacy-scan.mjs`. A non-zero
exit fails the workflow and blocks the merge.

## What Is Preserved vs. Anonymised

| Data | Action |
|---|---|
| `PilotSummary.name` in `pilots.json` (public) | Replaced with `[REDACTED]` at GDPR erasure time |
| Private pilot blob (`pilots/{id}.json`) PII fields | Nulled/replaced — see GDPR Erasure Runbook |
| League positions (`seasons/{year}.json`) | Preserved (historical record) |
| Round results (`results/{year}.json`) | Preserved (historical record) |
| Signature audit trail (`signatures/...`) | Preserved (legal obligation) |
| `rounds/{id}.json` PilotSnapshot | Preserved at locked values; live pilot shows `[REDACTED]` |
| `users/{id}.json` and `auth/{id}.json` | Deleted at GDPR erasure time |
| `user-index.json` email entry | Removed at GDPR erasure time |

See `docs/runbooks/gdpr-erasure.md` for the full GDPR right-to-erasure procedure.

## FAI Signature Validation: Outbound PII Egress

`apps/api/src/lib/faiVali.ts` (`validateIgcSignature`) uploads the raw IGC file for a
flight to the FAI online validator (`https://vali.fai-civl.org` by default, overridable
via `FAI_VALI_BASE_URL`) whenever `flightSignatureValidationEnabled` is on and a pilot
uploads or revalidates an IGC track. This is a genuine outbound PII egress: an IGC file's
`HFPLT` header carries the pilot's name, and its `B`-record track log is the pilot's GPS
flight path for that round. Both leave BCC's infrastructure and reach a third-party
service outside our control.

- **Scanner limitation**: `scripts/privacy-scan.mjs` only scans blobs written into the
  `data` (public) container. It has no visibility into this outbound HTTP call, so it
  cannot catch a regression that widens what gets sent to FAI or that sends flights that
  should have been exempted. Any change to `faiVali.ts` or its callers needs a manual
  privacy review; it is not covered by CI.
- **Disable controls**: setting the app setting `FAI_VALI_ENABLED=false` makes
  `validateIgcSignature` return `{signature: "unverified", faiStatus: "DISABLED"}`
  immediately, without any network call, regardless of the `config.json` toggle below.
  This is the hard kill switch for the outbound call itself (see
  `apps/api/local.settings.example.json`).
- **Feature toggle** (`config.json` → `flightSignatureValidationEnabled`, admin-editable
  via the Config page): turning this off does not retroactively re-score already-Complete
  rounds: a round's published score only changes on an explicit rescore
  (`POST /api/rounds/{id}/rescore`) or recompute. To apply a toggle flip to a round's
  score, rescore it; to repair the derived league table after a validation-driven score
  change on a `Complete` round, use `POST /api/manage/rounds/{id}/recompute`
  (`apps/api/src/functions/admin.ts`).
- **Queued jobs and the toggle**: disabling `flightSignatureValidationEnabled` does not
  purge jobs already sitting on the `igc-validation` queue. The `igcValidationWorker`
  re-reads `config.json` immediately before each FAI call, after acquiring the global
  guard, pacing, downloading the IGC, and re-checking the current flight attempt. If the
  toggle has since been switched off, the worker records `unverified`/`DISABLED` without
  sending the IGC to FAI. A call already past that final check remains in flight and can
  still complete; disabling the toggle does not cancel an outbound request that has
  already started.
