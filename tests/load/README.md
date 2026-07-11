# Load Testing (k6)

High-contention performance tests for the Sign-to-Fly journey. These tests measure the system's ability to handle hundreds of pilots registering and signing for a round simultaneously.

## Prerequisites

- **k6**: [Install k6](https://k6.io/docs/getting-started/installation/) on your machine.
  - macOS: `brew install k6`
  - Linux: Follow the official k6 docs for your distro.
  - Docker: `docker pull grafana/k6`
- **Target Environment**:
  - **Local**: A running dev stack (`make dev` or `docker compose up`).
  - **Azure**: A dedicated test instance. **NEVER run these tests against production.**

## The 6-Step Pipeline

The load test is split into phases because k6 (based on Goja) cannot easily share state with the Node.js seeding scripts, and the API enforces strict status guards that require multiple HTTP phases.

1.  **Prepare** (`make loadtest-prepare`): Creates a dedicated load-test round with 50 teams and 500 slots. It generates `tests/load/.prepared-round.json` which contains the metadata needed by k6.
2.  **Register** (`make loadtest-register`): Setup logs in all 500 pilots once in batches of 25, then 500 one-iteration virtual users (VUs) each call `/register-self` exactly once. This is the primary contention point for the round blob lease.
3.  **Transition** (`make loadtest-transition`): A single administrative call to move the round to the "Brief Complete" status, enabling the signing phase.
4.  **Sign** (`make loadtest-sign`): a `ramping-vus` executor drives 10 → 25 → 50 → 100 concurrent VUs calling the `/sign` endpoint on the same round to find the contention knee. A hard `sign_5xx: count==0` threshold fails the run on any sign-phase 5xx.
5.  **Verify** (`make loadtest-verify`): Logs in as admin, checks that all expected signatures persisted, waits up to 30 seconds for `slot.signToFly` to be materialized by the async `signtofly-reflect` queue consumer, and re-signs one slot to prove idempotency returns the same signature id.
6.  **Cleanup** (`make loadtest-cleanup`): Deletes the load-test round and its associated signatures to return the storage to a clean state.

## Running Locally

To run the full pipeline against your local Azurite/Functions stack:

```sh
# 1. Ensure fixtures are seeded (first time only)
make seed

# 2. Run the full load test pipeline
make loadtest
```

The `make loadtest` command chains all six steps. If any step fails, the pipeline stops.

### Step-by-Step execution

You can also run phases individually for debugging:

```sh
make loadtest-prepare
make loadtest-register
make loadtest-transition
make loadtest-sign
make loadtest-verify
make loadtest-cleanup
```

Stdout from k6 is persisted to `logs/load-test/{phase}-{timestamp}.log` (gitignored).

## Running Against Azure

To target a dedicated Azure test instance, you must provide the environment variables and configure the Function App.

### 1. Environment Variables

Set these in your shell before running the `make` targets:

```sh
export BCC_API_BASE_URL="https://your-loadtest-api.azurewebsites.net"
export ADMIN_PASSWORD="your-admin-password"
```

### 2. Function App Configuration

Ensure the following App Settings are set on the target Function App:

- `PURETRACK_ENABLED=false` (to avoid hitting PureTrack rate limits or costs)
- `ROUND_BRIEF_EMAILS=""` (to avoid sending 500 emails)
- `JWT_SECRET` (should already be a Key Vault reference)
- `ACS_CONNECTION_STRING` (should be a non-production resource or omitted)

### 3. Execution

```sh
# 1. Seed the 500 fixture pilots once
make seed

# 2. Run the load test cycles
make loadtest

# 3. Clean up the round
make loadtest-cleanup
```

## Interpreting Output

k6 produces a summary at the end of each phase. Look for these key metrics:

- `http_req_duration`: End-to-end request time (p90, p95).
- `http_req_failed`: The percentage of failed requests.
- `checks`: The success rate of the "login 200", "register ok", and "sign ok" assertions.

The register phase is the primary lease-contention measurement. It never retries: exactly 500 attempts, 500 successes, zero failures, and zero 5xx are hard thresholds. Its machine summary separates the 500 setup login requests/tokens from register attempts and register-only latency. The sign phase is a hard gate: server-side 5xx responses fail the k6 run. After k6 exits, `make loadtest-verify` is the correctness gate for persisted state: it fails non-zero if the signature ledger count is not the expected 500, if `signToFly` remains false after the bounded async drain window, or if re-signing an already signed slot creates a different signature id.

`signToFly` is not asserted instantaneously because signing now enqueues a `{ roundId }` job for the `signtofly-reflect` queue consumer. The verifier polls `GET /api/rounds/{roundId}` for about 30 seconds so the queue can drain while still preventing a hung or misleading-success load test.

### Baseline Metrics (Local)

> **These are illustrative observations, not latency SLO gates.** The register phase has exact count/error thresholds, and the sign phase is hard-gated on 5xx (see [§Interpreting output](#interpreting-output)). Numbers vary by hardware, contention, Azurite version. Don't compare local to Azure.

As a reference, these metrics were observed on a standard local dev stack:
- **Register phase**: 500 VUs finished in ~7m 40s.
- **Sign phase**: staged ramp 10 → 25 → 50 → 100 concurrent VUs on one round (~2m20s of staged load; the `sign_5xx` gate must stay at 0).

## Local vs Azure Differences

- **Cold Starts**: Azure Functions may experience cold starts on the first few requests.
- **Auto-scale**: Azure will attempt to scale out the Function App instances under load, whereas local execution is limited to your machine's CPU/RAM.
- **Lease Semantics**: Azure Storage lease timing and consistency may differ slightly from Azurite's emulation.
- **Register authentication**: Login is limited to 10 requests/minute per trusted client IP. One Azure load generator therefore cannot perform the required 500 setup logins. The script's unique `X-Forwarded-For` values only partition local Functions traffic; Azure uses its trusted `client-ip` value. Remote execution requires an approved partitioned-generator or token-provisioning design, which this load test does not supply.
- **Cost**: Running 500 VUs against Azure consumes execution units and storage transactions. Use dedicated test instances only.

## Design Choices & Safety

### Fixture Topology

Fixture seeding creates 500 pilots, 25 clubs, and 50 canonical teams, with 10 pilots per team. Preparation and full-pipeline behavior are documented with their orchestration changes.

### Safety Guards

- **Base URL**: `BCC_API_BASE_URL` should always point to a `loadtest` or `staging` environment. **NEVER target production.**
- **PHASE Guard**: The k6 script will exit immediately if the `PHASE` environment variable is not set to `register` or `sign`.
- **Operator Responsibility**: The scripts do not enforce environment safety; the operator must verify the target URL.

## Troubleshooting

- **Missing .prepared-round.json**: Run `make loadtest-prepare` first.
- **Wrong Round Status**: If you skip `make loadtest-transition`, the sign phase will fail because the round is not in "Brief Complete" status.
- **HTTP 429 (Too Many Requests)**: Setup authentication is limited to 10/min per trusted client IP. A local run uses unique XFF fallbacks; an Azure run from one generator IP is unsupported without an approved partitioned/token design.
- **HTTP 500 (Internal Server Error)**: Register and sign 500s are never retried and fail their runs.
- **Verify timeout**: `make loadtest-verify` timed out waiting for `signToFly=true`; inspect the Functions host logs for the `signtofly-reflect` queue consumer before cleanup.
- **Cold-start Latency**: In Azure, the first few iterations might show significantly higher latency.
