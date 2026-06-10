# Production Cutover Runbook

This document is the official execution plan for transitioning the BCC competition management from the legacy .NET application to the bccweb2 platform.

## Pre-flight Checklist

The pre-flight phase ensures the destination environment is hardened, secrets are seeded, and legal requirements are met before any data migration starts. Every item in this checklist must be verified by the operator before proceeding to the dry-run.

1. **Verify Infrastructure State**: Run `terraform -chdir=iac plan -var-file=env/<env>.tfvars` to ensure the state is current. Ensure the plan shows zero changes and specifically verify that blob versioning (30d), soft-delete (30d), and GRS are enabled. The management lock must be present on the storage account to prevent accidental deletion during the cutover.
2. **Confirm Secret Seeding**: See `iac/README.md` § Secret rotation for the declarative KV seeding flow. Execute `az keyvault secret show --vault-name <key_vault_name> --name jwt-secret` to confirm the JWT secret was successfully seeded. The Function App will fail to start if this secret is missing.
3. **Legal Wording Check**: Ensure that `docs/legal/sign-to-fly-wording.md` matches the version approved by the project owner in `.omo/evidence/legal/sign-to-fly-wording-approval.md`. Any discrepancy here invalidates the legal integrity of the first round's signatures.
4. **Local Migration Workspace**: Create a clean `.migration-state/` directory on the migration machine. Ensure the machine has the latest `node` (v20+) and `sqlcmd` utilities installed and can connect to both the legacy SQL Server and the target Azure Storage Account.

## Dry-run

The dry-run simulates the full migration without making any mutable changes to the production storage containers. It generates a reconciliation report that identifies any data mapping anomalies or schema violations.

Execute the migration script with the `--dry-run` flag:
```bash
node scripts/migrate/migrate.mjs --dry-run
```

Analyze the output in `.migration-state/reconciliation-report.json`. The operator must verify that the counts for Rounds, Pilots, Clubs, and Sites match the legacy database totals. Pay specific attention to the "orphans" section; any pilots without a corresponding person record or rounds without a season year are blockers that must be fixed in the legacy database before proceeding.

Finally, run the privacy scanner against the dry-run output (if exported to a local Azurite instance) using `node scripts/migrate/validate.mjs`. The scanner must return a clean pass (0 violations) to ensure no PII (emails, phone numbers, medical info) is leaked into the public `data` container.

## Reconciliation

Reconciliation is the process of proving that the migrated data is byte-compatible with the source of truth and conforms to the bccweb2 status state machine. This phase bridges the gap between the dry-run and the full migration.

Compare the `id-map.json` generated during the dry-run with the legacy SQL IDs. Every `legacyId` in the bccweb2 blobs must map back to exactly one record in the legacy system. Use the `scripts/migrate/reconcile-check.mjs` utility to perform a random sample check of 50 pilot profiles and 5 historical rounds.

```bash
node scripts/migrate/reconcile-check.mjs --sample-size 50
```

The reconciliation report must show "Zero Anomalies" in the status normalization bucket. Legacy statuses like "Submitted" or "Verified" must correctly map to "Proposed" or "Confirmed" respectively. Any record failing normalization will be logged as an anomaly and must be manually reviewed. Sign-off for this phase is granted only when the reconciliation report is attached to the cutover record.

## Full migration

The full migration is the point of no return for the data transition. It writes all entities to the production `data` and `data-private` containers. This must be performed during a scheduled maintenance window while the legacy app is in read-only mode.

1. **Legacy Read-Only**: Disable write access to the legacy SQL database or set the legacy app to "Maintenance Mode" at the load balancer.
2. **Execute Migration**:
   ```bash
   PRODUCTION_CONFIRM=YES node scripts/migrate/migrate.mjs --force-production
   ```
3. **Verify Write Success**: Monitor the logs for any 403 (Authentication) or 409 (Conflict) errors. The script uses idempotent UUIDs from `id-map.json`, so it can be resumed with `--resume` if interrupted.

Once complete, the script will output a final reconciliation report. This report is the primary evidence for the "Migration idempotency + reconciliation" row in the Sign-off Matrix. Do not proceed to DNS cutover until this report confirms 100% record parity.

## Validation

Validation ensures the newly written blobs are accessible by the API and correctly formatted for the SPA. This phase uses the automated test suite against the live production environment (before the public DNS is switched).

Run the production validation suite:
```bash
# Verify public blob accessibility and PII redaction
node scripts/migrate/validate.mjs --source "https://<storage_account>.blob.core.windows.net"

# Run API integration tests against the production function endpoint
# Note: Requires a valid admin token for the production environment
API_BASE_URL="https://<function_app_name>.azurewebsites.net" bun test apps/api/src/__tests__/integration
```

Ensure the Application Insights dashboard shows no 5xx errors during these tests. Check the `exceptions` table in Kusto for any `StatusNormalizationError` or `BlobLeaseError`. Validation is complete when the privacy scanner returns a clean pass and the API response times for the `pilots.json` and `rounds.json` endpoints are within the expected 200ms threshold.

## Smoke test

The smoke test is a high-level walkthrough of the critical pilot and coordinator journeys. This is the final manual gate before public traffic is admitted to the platform.

1. **Sign-in Flow**: Use a test pilot account to sign in. Verify the 401 auto-refresh logic works by manually deleting the access token from localStorage and clicking a protected link.
2. **Sign-to-Fly Flow**: Navigate to a "BriefComplete" round. Verify the legal wording is rendered correctly. Click "Accept" and verify that a new record is created in the `signatures/` private container.
3. **Coordinator Lock**: As an admin, lock a round. Verify that the `PilotSnapshot` is created and that the round status transitions to "Locked".

Capture screenshots of these three successful journeys and save them to `.omo/evidence/cutover-smoke/`. These screenshots serve as the "Evidence Path" for the "Application Insights + alert rules" and "Auth integration suite" sign-off rows.

## DNS cutover

DNS cutover moves public traffic from the legacy hostname to the new bccweb2 Azure Static Web App and ACS email domain. This phase requires access to the domain registrar and Azure Portal.

The detailed runbook (TTL strategy, SPF/DKIM/DMARC verification, manual-vs-Terraform CNAME path, validation script, rollback) lives at `docs/runbooks/dns-cutover.md`. The short version:

1. **ACS Email Domain**: Execute the DNS verification in the registrar using the records provided by `terraform -chdir=iac output -var-file=env/<env>.tfvars acs_email_domain_verification_records` (SPF, DKIM, DKIM2 and DMARC, broken out by type). Publish DMARC with `p=none` for first cutover — tighten after one clean week. Confirm verification in the Azure Portal under the Communication Services resource.
2. **CNAME Update**: Update the primary CNAME record (e.g. `bcc.flyparagliding.org.uk`) to point at `terraform -chdir=iac output -var-file=env/<env>.tfvars -raw production_hostname_target` (the stable, cert-bound SWA default hostname). If `var.dns_zone_name` is set, Terraform owns this record via `iac/dns.tf`; otherwise the operator does this at the registrar.
3. **TTL Strategy**: 24h before cutover lower TTL to 300s; flip target at 300s; raise back to 3600s 24h after stable traffic. See `docs/runbooks/dns-cutover.md` for the full schedule.
4. **Validation**: run `PROD_HOST=... SWA_HOST=... API_HOST=... ACS_EMAIL_DOMAIN=... bash scripts/iac/validate-dns.sh` and capture the output to `.omo/evidence/task-51-dns.txt`.

Monitor the SWA metrics for the first 15 minutes. Ensure the `2xx` count increases and `4xx`/`5xx` counts remain at baseline. If the CNAME update results in a SSL/TLS handshake error, verify that the SWA custom domain has successfully validated the certificate.

## Rollback window

The rollback window is the period during which the team commits to maintaining the ability to revert to the legacy system with zero data loss. Per User Decision #7, this window is **7 days**.

During this 7-day window:
- The legacy SQL database must remain online in read-only mode (to serve as a reference).
- No blobs in the Azure storage account may be permanently deleted (versioning must be set to >= 30 days to cover the 7-day window plus a safety margin).
- The `_current` symlink on the legacy server (if applicable) must point to a backup of the legacy binaries.

At the end of the 7 days, if no critical "Rollback" level incidents are open, the decommission phase may begin. If a rollback is triggered, the window is reset once the issue is resolved and a new cutover date is set.

## Decommission

Decommissioning involves the permanent removal of legacy infrastructure and the formal closure of the migration project. This occurs only after the 7-day rollback window has elapsed without incident. See `docs/runbooks/decommission.md` for the full post-window decommission plan.

1. **Legacy App Shutdown**: Stop the IIS site or App Service hosting the legacy .NET application.
2. **Database Archive**: Perform a final backup of the legacy SQL database and move the `.bak` file to long-term cold storage (e.g., Azure Archive Tier).
3. **Infrastructure Cleanup**: Run `terraform -chdir=iac destroy -var-file=env/<env>.tfvars` on any legacy-specific infrastructure that was not migrated to bccweb2.

Formal sign-off for decommissioning is required from the project owner (Matt White). This sign-off confirms that the new platform is stable, all historical data is safely archived, and the legacy system is no longer incurring costs or security risks.

## Sign-off Matrix

| Blocker | Owner Name | Sign-off Date (YYYY-MM-DD) | Evidence Path | Status (pending/signed-off) |
|---|---|---|---|---|
| Sign-to-Fly wording approval | - | - | `.omo/evidence/legal/sign-to-fly-wording-approval.md` | pending |
| PII removal verified | - | - | `.omo/evidence/task-22-clean-pass.txt` + `task-21-no-pii-public.txt` | pending |
| Storage hardening (versioning, soft-delete, GRS, mgmt lock) | - | - | `.omo/evidence/task-6-iac-plan-assertions.txt` | pending |
| JWT_SECRET + ACS in Key Vault | - | - | `.omo/evidence/task-7-kv-ref-in-plan.txt` | pending |
| Migration idempotency + reconciliation | - | - | `.omo/evidence/task-8-idempotent-dryrun.txt` + `task-43-migration-smoke.txt` | pending |
| ACS email domain DNS verification | - | - | `.omo/evidence/task-51-dns.txt` + `.omo/evidence/task-51-mail-score.txt` (see `docs/runbooks/dns-cutover.md`) | pending |
| Application Insights + alert rules | - | - | TBD by T46+T47 | pending |
| Post-deploy smoke gate in CI | - | - | TBD by T48 | pending |
| Auth integration suite + round lifecycle suite green | - | - | `.omo/evidence/task-41-auth-suite.txt` + `task-42-lifecycle-suite.txt` | pending |
| Scoring regression suite green | - | - | `.omo/evidence/task-44-scoring-regression.txt` | pending |
| Production dry-run + reconciliation report zero anomalies | - | - | TBD by T50 | pending |

## Communication plan

A successful cutover requires clear communication with all stakeholders (pilots, club coordinators, and admins) to manage expectations and minimize support overhead.

### Pre-cutover Announcement (Email Template)
**Subject**: Important: BCC Website Migration - Maintenance Window
**Body**:
Hi Pilots,
We are moving to the new BCC management platform (bccweb2) on [DATE].
Between [TIME_START] and [TIME_END], the website will be in maintenance mode. 
**Action Required**: After the cutover, you will need to sign in and accept the updated 2026 Terms & Conditions before signing to fly in your next round.
The new site is mobile-optimised and includes improved round registration and safety briefing flows.

### Maintenance Page Text
"The BCC website is currently undergoing a scheduled upgrade to the bccweb2 platform. We expect to be back online by [TIME_END]. Thank you for your patience."
Reference Image: `/apps/web/public/assets/maintenance-glider.png`

### Post-cutover All-Clear Message
"The migration to bccweb2 is complete. All systems are green. Pilots can now sign in at bcc.flyparagliding.org.uk to update their profiles and register for upcoming rounds."

## Rollback plan

The rollback plan provides a guaranteed path back to the legacy system if the bccweb2 platform fails in production. It must be executable within 1 hour.

### 1. Revert DNS
Immediately point the primary CNAME back to the legacy host:
```bash
# Verify current state
dig bcc.flyparagliding.org.uk CNAME

# At registrar: Change bcc.flyparagliding.org.uk from <SWA_HOST> to <LEGACY_HOST>
# (e.g. bcc-legacy.flyparagliding.org.uk)
```

### 2. Restore Storage State
If data corruption occurred in the Azure containers, use the versioning/soft-delete features to restore:
```bash
# List versions of a corrupted blob
az storage blob version list --container data --name rounds.json --output table

# Restore the version prior to cutover
az storage blob copy start \
  --source-uri "https://<storage>.blob.core.windows.net/data/rounds.json?versionId=<OLD_VERSION>" \
  --destination-blob rounds.json \
  --destination-container data
```

### 3. Re-enable Legacy App
Switch the legacy application from read-only/maintenance mode back to active.
- Re-enable SQL write permissions for the legacy app user.
- Start the IIS site on the legacy server.
- Verify connectivity to the legacy database via `curl -I http://bcc-legacy.flyparagliding.org.uk`.
