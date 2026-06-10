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

## The 5-Step Pipeline

The load test is split into phases because k6 (based on Goja) cannot easily share state with the Node.js seeding scripts, and the API enforces strict status guards that require multiple HTTP phases.

1.  **Prepare** (`make loadtest-prepare`): Creates a dedicated load-test round with 50 teams and 500 slots. It generates `tests/load/.prepared-round.json` which contains the metadata needed by k6.
2.  **Register** (`make loadtest-register`): 500 virtual users (VUs) log in and call `/register-self` concurrently. This is the primary contention point for the round blob lease.
3.  **Transition** (`make loadtest-transition`): A single administrative call to move the round to the "Brief Complete" status, enabling the signing phase.
4.  **Sign** (`make loadtest-sign`): 500 VUs call the `/sign` endpoint concurrently to complete their Sign-to-Fly declaration.
5.  **Cleanup** (`make loadtest-cleanup`): Deletes the load-test round and its associated signatures to return the storage to a clean state.

## Running Locally

To run the full pipeline against your local Azurite/Functions stack:

```sh
# 1. Ensure fixtures are seeded (first time only)
make seed

# 2. Run the full load test pipeline
make loadtest
```

The `make loadtest` command chains all five steps. If any step fails, the pipeline stops.

### Step-by-Step execution

You can also run phases individually for debugging:

```sh
make loadtest-prepare
make loadtest-register
make loadtest-transition
make loadtest-sign
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
- `checks`: The success rate of the "login 200", "register ok", and "sign 200" assertions.

**Note**: The test runs in advisory mode. There are no hard thresholds that fail the build. High concurrency on a single blob will cause lease contention, resulting in some HTTP 500 errors. The k6 script automatically retries these up to 5 times.

### Baseline Metrics (Local)

As a reference, these metrics were observed on a standard local dev stack:
- **Register phase**: 500 VUs finished in ~7m 40s.
- **Sign phase**: 500 VUs finished in ~8m 00s.

## Local vs Azure Differences

- **Cold Starts**: Azure Functions may experience cold starts on the first few requests.
- **Auto-scale**: Azure will attempt to scale out the Function App instances under load, whereas local execution is limited to your machine's CPU/RAM.
- **Lease Semantics**: Azure Storage lease timing and consistency may differ slightly from Azurite's emulation.
- **Cost**: Running 500 VUs against Azure consumes execution units and storage transactions. Use dedicated test instances only.

## Design Choices & Safety

### Single Organising Club

The load-test round uses one organising club and all 50 teams belong to that same club. This is because the `register-self` API requires the pilot to belong to a club in the round. The fixture-only flag `autoAllocatePilotsToRoundClub: true` is set during `make seed` to allow all 500 pilots to auto-allocate to this club. This ensures we measure the **round-blob lease contention** rather than club-membership logic.

### Safety Guards

- **Base URL**: `BCC_API_BASE_URL` should always point to a `loadtest` or `staging` environment. **NEVER target production.**
- **PHASE Guard**: The k6 script will exit immediately if the `PHASE` environment variable is not set to `register` or `sign`.
- **Operator Responsibility**: The scripts do not enforce environment safety; the operator must verify the target URL.

## Troubleshooting

- **Missing .prepared-round.json**: Run `make loadtest-prepare` first.
- **Wrong Round Status**: If you skip `make loadtest-transition`, the sign phase will fail because the round is not in "Brief Complete" status.
- **HTTP 429 (Too Many Requests)**: Each pilot has a 10/min rate limit on registration. If you restart the register phase too quickly, you may hit this.
- **HTTP 500 (Internal Server Error)**: Often indicates lease contention. If retries are exhausted, k6 will report a failure.
- **Cold-start Latency**: In Azure, the first few iterations might show significantly higher latency.
