# Alerts Runbook

This runbook describes every Azure Monitor alert defined in `iac/modules/stamp/alerts.tf`. Each alert routes to the single `module.stamp.azapi_resource.ops` (email = `var.ops_email`, optional Slack webhook = `var.slack_webhook_url`).

## Severity convention

| Severity | Meaning | Response |
|---|---|---|
| 1 | Real fire — page on-call immediately | Acknowledge within 15 minutes, mitigate within 1 hour |
| 2 | Investigate-async — anomaly worth a human look | Triage within 4 hours during business hours; out-of-hours, batch with next morning standup unless escalates |

A severity 1 alert that fires repeatedly inside a 30-minute window should be escalated to the project owner (Matt White). A severity 2 alert that fires every evaluation period for more than 24 hours should be upgraded to severity 1 by editing the corresponding resource in `iac/alerts.tf` and re-applying.

## Action group

The action group `ag-bccweb-prod-ops` is the single fan-out point. To rotate the on-call address:

```bash
# Update terraform.tfvars (NOT this file) and re-apply:
terraform -chdir=iac init -backend-config=env/prod.backend.hcl
terraform -chdir=iac apply -var-file=env/prod.tfvars -target=module.stamp.azapi_resource.ops
```

To add an additional receiver (PagerDuty, OpsGenie, etc.), add a new `*_receiver` block inside the action group resource — never create a second action group, the per-alert `action_group_id` references would diverge.

---

## api-5xx-rate

**Severity**: 1 (page)

### What it means

The Function App's HTTP 5xx response rate exceeded 1% of total requests over the last 5 minutes, with an absolute floor of 5 errors (so a single 5xx on a quiet day does not page). At 1% rate this is real user-facing breakage: pilots are seeing failures on the SPA.

### Likely causes

- A regression in the latest Function App deployment (check the most recent CI deploy timestamp).
- Storage account 5xx (correlate with `storage-server-errors`; if both are firing, fix storage first).
- Key Vault access failure causing JWT/AI/ACS secret resolution to throw 500s on every authenticated request (correlate with the AI `exceptions` table for `KeyVaultReferenceException`).
- Cold-start storms on the Y1 SKU after a long idle period — usually self-clears within one evaluation window.

### Immediate response

1. Open App Insights and run:
   ```kql
   requests
   | where timestamp > ago(15m)
   | where toint(resultCode) >= 500
   | summarize count() by name, resultCode, bin(timestamp, 1m)
   | order by timestamp desc
   ```
   to identify which Function and which 5xx code dominate.

2. Pull the recent exception stack:
   ```kql
   exceptions
   | where timestamp > ago(15m)
   | summarize n = count(), latest = max(timestamp), sample_stack = any(details) by type, problemId
   | order by n desc
   ```

3. If the regression maps to a recent deploy, roll back the Function App package via Azure CLI:
   ```bash
   az functionapp deployment list-publishing-credentials \
      --name "$(terraform -chdir=iac output -var-file=env/prod.tfvars -raw function_app_name)" \
      --resource-group "$(terraform -chdir=iac output -var-file=env/prod.tfvars -raw resource_group_name)"
   # then use the previous WEBSITE_RUN_FROM_PACKAGE URL stored in CI artifacts
   ```

4. If storage is the cause, follow `storage-server-errors` below first.

### Page vs investigate-async

Page. Acknowledge inside 15 minutes; mitigate (deploy rollback or feature flag) inside 1 hour. If neither rollback nor mitigation is possible, post a status banner via the SPA maintenance page wording in `docs/runbooks/cutover.md#maintenance-page-text`.

### Escalation

If unmitigated after 1 hour: escalate to project owner (Matt White) via the contact in `decisions.md`.

---

## function-execution-failures

**Severity**: 2 (investigate-async)

### What it means

More than 10 Function executions in the last 5 minutes returned `success == false` in App Insights. Unlike `api-5xx-rate` this counts every failure regardless of resultCode (a 4xx that the handler logs as a failure also counts), so this captures coordinator-side validation regressions and timer-bound failures that don't show up as HTTP 5xx.

### Likely causes

- A misbehaving cron caller hammering a validation endpoint (RoundsCoord client looping on a 409 conflict).
- A single pathological round/pilot whose blob fails repeated validation in `roundsMutate` or `signTofly/ledger`.
- ACS or PureTrack upstream returning errors that bubble up as 502 from `puretrack.ts` / `email.ts`.

### Immediate response

1. Identify the failure-dominant handler and caller:
   ```kql
   requests
   | where timestamp > ago(30m) and success == false
   | summarize n = count() by name, resultCode
   | order by n desc
   ```

2. Pull the exception sample for the top handler:
   ```kql
   exceptions
   | where timestamp > ago(30m)
   | where operation_Name == "<HandlerName>"
   | take 20
   ```

3. If the cause is a single bad caller, capture their identity from `customDimensions.userId` (already redacted to sha8 by `telemetryRedactor`) and ask Admin to investigate via the user index.

### Page vs investigate-async

Investigate-async. Triage during business hours. Page only if this alert co-fires with `api-5xx-rate` for more than two consecutive evaluation windows.

### Escalation

If failures persist over 24h with no root cause identified: escalate to project owner and consider upgrading severity to 1 in `iac/alerts.tf`.

---

## storage-server-errors

**Severity**: 1 (page)

### What it means

The storage account returned more than 5 transactions tagged `ServerBusyError` (HTTP 503 throttle) or `ServerOtherError` (generic server-side failure) inside a 1-minute window, sustained over a 5-minute evaluation window. Because all persistence is blob-only (no DB — see `AGENTS.md`), sustained storage 5xx == site-down.

### Likely causes

- Hot partition / scale ceiling on the `data` or `data-private` container (large recompute fan-out, mass import).
- An infrastructure-level Azure incident in the resource group's region (`uksouth`). Check `https://status.azure.com`.
- A storage account configuration drift removing GRS or enabling network restrictions that block the Function App.

### Immediate response

1. Confirm the storage account is healthy:
   ```bash
   az storage account show \
      --name "$(terraform -chdir=iac output -var-file=env/prod.tfvars -raw storage_account_name)" \
      --resource-group "$(terraform -chdir=iac output -var-file=env/prod.tfvars -raw resource_group_name)" \
     --query "{provisioning: provisioningState, status: statusOfPrimary, sku: sku.name}"
   ```

2. Identify the API operation responsible:
   ```kql
   AzureMetrics
   | where TimeGenerated > ago(15m)
   | where ResourceProvider == "MICROSOFT.STORAGE"
   | where MetricName == "Transactions"
   | where Properties has "ServerBusyError" or Properties has "ServerOtherError"
   | summarize sum(Total) by bin(TimeGenerated, 1m)
   | order by TimeGenerated desc
   ```

3. If throttled, throttle the caller: pause any in-flight migration (`scripts/migrate/migrate.mjs`), back off recompute fan-out by waiting for `recomputeSeason` in-flight promise to settle (already single-flight per process, but parallel function instances multiply load).

4. If a regional Azure incident, switch the maintenance page on the SWA per `docs/runbooks/cutover.md#rollback-plan` and wait for the underlying incident to resolve. GRS replication does not protect against control-plane outages.

### Page vs investigate-async

Page. Acknowledge inside 15 minutes. If unmitigated inside 30 minutes, raise an Azure support case (severity B).

### Escalation

Storage 5xx is the only alert in this runbook that can persist without operator action because it depends on Azure-side recovery. Escalate to project owner inside 30 minutes regardless of perceived root cause.

---

## auth-lockout-spike

**Severity**: 2 (investigate-async)

### What it means

More than 5 distinct `[METRIC] auth.lockout.triggered` log lines (emitted by `apps/api/src/lib/rateLimit.ts` from T16) occurred in the last 15 minutes. Each line represents a user crossing the 5-failure / 10-minute threshold. The userId in the log is already SHA-8 truncated, so the alert message contains no PII.

### Likely causes

- Credential stuffing attempt using a leaked password list.
- A widespread password manager outage causing pilots to mistype.
- A SPA regression in the login form (token format mismatch, stale CSRF, etc.) causing every legitimate login to fail.

### Immediate response

1. Confirm whether the lockouts are concentrated on a small set of users (likely a SPA regression) or spread across many (likely credential stuffing):
   ```kql
   traces
   | where timestamp > ago(1h)
   | where message has "[METRIC] auth.lockout.triggered"
   | extend userHash = extract("userId=([0-9a-f]+)", 1, message)
   | summarize n = count() by userHash
   | order by n desc
   ```

2. If concentrated on a single SPA build version:
   - Roll back the SWA deployment (`az staticwebapp environment delete --name <env>` or revert via SWA portal).

3. If spread across many users and IPs (credential stuffing pattern):
   - Increase the lockout duration temporarily in `rateLimit.ts` (e.g. 60 minutes) and redeploy.
   - Notify project owner; consider enabling Cloudflare WAF rate-limiting if available.

4. If a single user is hammering, that user is already locked out for 15 minutes — no further action needed beyond noting their userHash in the incident log.

### Page vs investigate-async

Investigate-async by default. Page if the rate exceeds 20 lockouts in 15 minutes (5x threshold).

### Escalation

If credential-stuffing pattern is confirmed: escalate to project owner and document in `.omo/evidence/incidents/`.

---

## lockround-p95-duration

**Severity**: 2 (investigate-async)

### What it means

The p95 duration of the `lockRound` Function over the last 30 minutes exceeded 30s. `lockRound` is the slowest orchestration in the API: it generates the brief PDF, optionally creates PureTrack groups, and sends ACS emails. The window is intentionally 30 minutes (not 5) because `lockRound` is low-volume and a shorter window has insufficient samples (the alert guards with `n >= 3`).

### Likely causes

- PureTrack upstream slow / hanging (T34 introduced skip handling but slow responses still block the lease window).
- Memory pressure on the Y1 SKU during PDF generation (`apps/api/src/lib/pdf.ts`) for a round with many pilots / large brief content.
- ACS email send timing out under retry, blocking the orchestration.
- A blob lease contention storm if multiple coordinators are locking adjacent rounds concurrently.

### Immediate response

1. Run the p95 query to confirm the regression:
   ```kql
   requests
   | where timestamp > ago(2h)
   | where name == "lockRound" or operation_Name == "lockRound"
   | summarize p50 = percentile(duration, 50), p95 = percentile(duration, 95), n = count() by bin(timestamp, 5m)
   | order by timestamp desc
   ```

2. Inspect dependencies to identify the slow component:
   ```kql
   dependencies
   | where timestamp > ago(30m)
   | where operation_Name == "lockRound"
   | summarize avg(duration), p95 = percentile(duration, 95), n = count() by target, name
   | order by p95 desc
   ```

3. If PureTrack is the culprit, the existing `puretrack.skip` metric path (T34) means the alert is informational only. Confirm no error storm in `[METRIC] puretrack.create.failed`.

4. If PDF generation is the culprit, check the round size and consider chunking the brief content; the Y1 SKU has a hard 1.5GB memory ceiling per instance.

### Page vs investigate-async

Investigate-async. Pilots can still view existing rounds and register; only the locking workflow is degraded.

### Escalation

If p95 exceeds 90s consistently: escalate and consider scaling the Function App to a Premium SKU for headroom.

---

## recompute-marker-stale

**Severity**: 2 (investigate-async)

### What it means

A `[METRIC] recompute.marker.stale` trace fired in the last 15 minutes. This indicates a season recompute marker (the in-blob completion timestamp written by `recomputeSeason` in `apps/api/src/lib/recompute.ts`) is older than its expected SLO.

### Status of the emitter

As of T47, no code path emits `[METRIC] recompute.marker.stale` directly. The alert is forward-looking and will not fire until either:

- A scheduled probe Function is added (out of scope for T47), OR
- The existing `recomputeSeason` path is extended to log this trace when it detects an unexpectedly old marker before re-running.

This is intentional — the alert resource is in place so that the emitter can be merged later without requiring an additional Terraform apply. Until then, expect zero fires; that is the correct baseline.

### Likely causes (once emitter ships)

- A season's recompute path threw an exception before writing the marker (the lock blob `seasons/{year}.json.lock` remains, but no marker was written).
- Single-flight in-process promise short-circuited before the swap completed.
- Blob soft-delete restored an older `seasons/{year}.json` without updating the marker.

### Immediate response

1. Identify which season is stale:
   ```kql
   traces
   | where timestamp > ago(1h)
   | where message has "[METRIC] recompute.marker.stale"
   | project timestamp, message, customDimensions
   ```

2. Inspect the marker directly:
   ```bash
   az storage blob show \
     --container data \
     --name "seasons/<year>.json" \
      --account-name "$(terraform -chdir=iac output -var-file=env/prod.tfvars -raw storage_account_name)" \
     --query "properties.lastModified"
   ```

3. Trigger a manual recompute (admin endpoint or follow the seed script pattern), then re-check the marker.

### Page vs investigate-async

Investigate-async. League JSON staleness affects only the public season page; pilots can still register and view rounds.

### Escalation

If stuck after one manual recompute attempt: escalate to project owner and inspect for lease contention via `seasons/<year>.json.lock` blob.

---

## How to add a new alert

1. Add the resource to `iac/modules/stamp/alerts.tf` referencing `module.stamp.azapi_resource.ops.id`.
2. Add a section to this runbook with the same five subsections (What it means / Likely causes / Immediate response / Page vs investigate-async / Escalation).
3. Verify the plan:
   ```bash
    terraform -chdir=iac init -backend-config=env/prod.backend.hcl
    terraform -chdir=iac plan -var-file=env/prod.tfvars
    ```
4. Append the chosen metric / KQL query to `.omo/notepads/bccweb2-go-live-gap-closure/learnings.md`.

## Silencing an alert during planned work

Use Azure Monitor action rules (suppression) at the subscription level rather than disabling the resource in Terraform — disabling in code creates a drift surface and risks the alert staying disabled past the maintenance window. Suppression rules expire automatically.

```bash
az monitor action-rule create \
  --name "maintenance-$(date +%Y%m%d-%H%M)" \
  --resource-group "$(terraform -chdir=iac output -raw resource_group_name)" \
  --rule-type Suppression \
  --suppression-recurrence-type Once \
  --suppression-start-date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --suppression-end-date "$(date -u -v+2H +%Y-%m-%dT%H:%M:%SZ)"
```
