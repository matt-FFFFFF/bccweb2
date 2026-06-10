# Load Testing Runbook

This runbook describes how to execute and interpret the BCC load test suite. The suite simulates a high-concurrency "round opening" event where 500 pilots register for a round and subsequently sign the safety briefing.

## 1. Purpose

The load test verifies that the API's blob-lease orchestration correctly handles high contention. It proves that the identity-keyed rate limit allows simultaneous registration from shared-NAT locations (e.g., the same takeoff hill) while protecting against individual abuse.

## 2. Prerequisites

- **k6**: Installed and on PATH (`brew install k6` or equivalent).
- **Admin Access**: For local dev, this is seeded automatically. For Azure, the operator must have the `ADMIN_PASSWORD` or a valid `.dev-credentials` file.
- **Fixture State**: The environment must be seeded with 500 pilots and 50 clubs before running the load test.

## 3. Standard run (local)

The local suite runs against the `docker compose` stack.

```bash
# 1. Start the stack
make dev

# 2. Run the full chain (seed -> prepare -> register -> transition -> sign -> cleanup)
make loadtest
```

Individual phases can be run via:
- `make loadtest-prepare`: Creates a Confirmed round with 50 teams.
- `make loadtest-register`: Runs k6 register phase (500 VUs).
- `make loadtest-transition`: Moves round to BriefComplete.
- `make loadtest-sign`: Runs k6 sign phase (500 VUs).

## 4. Standard run (Azure target)

Running against an Azure target requires setting the target URL and providing the admin password.

```bash
# 1. Set environment
export BCC_API_BASE_URL="https://your-loadtest-api.azurewebsites.net"
export ADMIN_PASSWORD="your-vault-secret"

# 2. Execute
make loadtest
```

## 5. Azure test-instance configuration

Never run load tests against the production instance. A dedicated load-test Function App must be configured with these settings:

- `PURETRACK_ENABLED=false`: Disables outbound calls to PureTrack.
- `ROUND_BRIEF_EMAILS=""`: Disables briefing emails to avoid spamming pilots.
- `JWT_SECRET`: Standard Key Vault reference.
- `ACS_CONNECTION_STRING`: Standard connection string or omitted.
- `AZURE_FUNCTIONS_ENVIRONMENT`: `Development` or `Staging`.

To set via Azure CLI:
```bash
az functionapp config appsettings set \
  --name <app_name> \
  --resource-group <rg> \
  --settings PURETRACK_ENABLED=false ROUND_BRIEF_EMAILS=""
```

The storage account must have `data` and `data-private` containers created.

## 6. Warm-up recommendation

Azure Functions on the Y1 (Consumption) SKU experience cold-starts. Before running k6 against an idle Azure instance, prime the host:

```bash
for i in $(seq 1 30); do 
  curl -s ${BCC_API_BASE_URL}/api/health > /dev/null
done
```

## 7. Observed Metrics (Baselines)

These metrics were recorded on a local M-series Mac using the Azurite stack. They are advisory baselines, not hard gates:

- **Register Phase**: 500/500 pilots registered in **07m 39s**.
- **Sign Phase**: 500/500 pilots signed in **07m 58s**.

## 8. Why the load test works without bypass

Historically, load tests required a "bypass" environment variable to skip rate limits. This suite uses the production rate-limit implementation from `apps/api/src/lib/rateLimit.ts`.

By passing `identityKey: caller.pilotId` to the rate limiter, every pilot has their own 10/min budget. Because 500 different pilots register in the test, they never collide with each other's rate-limit buckets. This identity-keyed limiting is a permanent production improvement that solves the "Shared NAT" problem where multiple pilots on the same network would previously share a single IP-based budget.

## 9. Data lifecycle

1. **Prepare**: Creates a `tests/load/.prepared-round.json` file containing the round ID and the 500 pilot credentials used for the run.
2. **Cleanup**: Deletes the round blob and all 500 signature blobs created during the run.
3. **Fixtures**: The 500 pilot/user/auth blobs are preserved between runs to save seeding time (~14s).

## 10. Privacy note

Load test fixtures contain synthetic data only (`pilotXXX@bcc.local`). The `scripts/privacy-scan.mjs` utility runs in CI to ensure these synthetic fields do not leak into the public container. Never use real pilot data in a load test environment.

## 11. Failure modes & remediation

### register-self returns 429
- **Cause**: Stuck buckets from a prior aborted run or a single pilot VU looping too fast.
- **Remediation**: Wait 5 minutes for buckets to refill or restart the API process.

### sign returns 409 INVALID_STATE
- **Cause**: The round was not transitioned to `BriefComplete`.
- **Remediation**: Re-run `make loadtest-transition`.

### sign returns 500 in Azure mode
- **Cause**: The brief-lifecycle fix (auto-brief creation on confirm) is not deployed.
- **Remediation**: Verify the deployed commit includes the `confirmRound` auto-brief block.

### register-self returns 409 NOT_IN_CLUB_FOR_SEASON "Round has no organising club"
- **Cause**: The load-test round was created without an organising club, or pilots are not members of that club.
- **Remediation**: This was the Wave-4 bug. The fix is ensuring `prepare-loadtest.mjs` passes `organisingClubId`, all 50 teams share that clubId, and `config.json` has `autoAllocatePilotsToRoundClub: true`.

### bcrypt slow on cold start
- **Cause**: First login involves high CPU cost for bcrypt.
- **Remediation**: Expected on first run; subsequent logins are faster due to token reuse in the script or warm host.

### Azurite OOM (local)
- **Cause**: Azurite memory leak during long high-concurrency runs.
- **Remediation**: `make docker-down && make dev`.

### p95 latency outliers
- **Cause**: Blob lease contention. Multiple VUs attempting to write to the same round blob simultaneously.
- **Remediation**: This is expected. The k6 script includes retries to handle these 500/409 errors.

### Surprise emails/PureTrack groups
- **Cause**: `ROUND_BRIEF_EMAILS` or `PURETRACK_ENABLED` not configured correctly.
- **Remediation**: Check Section 5 and update app settings.

## 12. Cost note

A 500-VU load test against Azure Consumption (Y1) costs approximately $0.05 in execution time and storage transactions. The primary cost is operator time.

## 13. Security & Identity

The test uses `tests/load/.prepared-round.json` which contains synthetic login tokens. This file is chmod 600 and ignored by git. Do not share this file.

## 14. Safety convention

`BCC_API_BASE_URL` must contain `loadtest` or `staging`. **NEVER run against a production hostname.** The scripts do not enforce this; it is the operator's responsibility.

## 15. References

- `AGENTS.md`: Repository conventions.
- `apps/api/src/lib/rateLimit.ts`: Identity-keyed limiting source.
- `scripts/prepare-loadtest.mjs`: Test setup logic.
- `tests/load/sign-to-fly.js`: k6 script source.
