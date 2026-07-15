# iac/environment — per-env application stack

The application infrastructure for one environment: a single `terraform
apply` that provisions both the platform layer (observability + email) and
the application stamp. See [../README.md](../README.md) for the overall
layout.

## Purpose

Composes two child modules in one plan/state:

- [`modules/platform`](modules/platform): per-env Log Analytics workspace,
  Application Insights, and the ACS email service + DNS-verified domain.
  Deployed into the bootstrap-created platform resource group
  (`platform_rg_name`).
- [`modules/stamp`](modules/stamp): the app's storage account, Function App
  (Flex/Linux, UMI), Static Web App, Key Vault (RBAC, 6 secrets), ACS
  `communicationServices` (linked to the platform module's email domain by
  ID), 7 alert rules + ops action group, and an optional production DNS
  CNAME. Deployed into the bootstrap-created stamp resource group
  (`stamp_rg_name`).

Both resource groups are pre-created by
[`iac/bootstrap`](../bootstrap/README.md), which also grants the env's
Terraform UMI Owner on each — neither module creates or reads a resource
group itself.

## Backend

`../env/<env>.backend.hcl` (committed) — state key `<env>.tfstate` in the
bootstrap storage account. **Known drift**: bootstrap's `local_file`
resource currently generates `iac/<env>.backend.hcl` (repo root) with a
different container/storage-account naming scheme than the committed
`../env/<env>.backend.hcl` files actually reference. This is a known,
out-of-scope branch inconsistency — see [../README.md](../README.md#layout)
— always use `../env/<env>.backend.hcl`, never the root-level generated
file.

## tfvars

`../env/<env>.tfvars` — **gitignored** (holds the ACS email domain, operator
emails, and PureTrack credentials). Local applies: copy
`../env/<env>.tfvars.example` and fill in. CI: the `terraform.yml` workflow
generates the non-sensitive half of the file at runtime from GitHub
environment-scoped variables and passes secrets via `TF_VAR_*` environment
variables (see `.github/workflows/terraform.yml`).

## Required inputs

Every apply needs these set (via tfvars locally, or GitHub environment
vars/secrets in CI):

| Variable | Source | Notes |
|---|---|---|
| `stamp_name` | tfvars / CI-generated | Environment name used as the resource-name suffix. |
| `platform_rg_name` | `TF_VAR_PLATFORM_RG_NAME` | Published by bootstrap as a GitHub environment variable. |
| `stamp_rg_name` | `TF_VAR_STAMP_RG_NAME` | Published by bootstrap as a GitHub environment variable. |
| `acs_email_domain` | `TF_VAR_ACS_EMAIL_DOMAIN` | **Not** published by bootstrap — the operator sets this GitHub environment variable (or the local tfvars value) directly; see [../README.md](../README.md#first-time-setup). |
| `ops_email` | tfvars / `vars.OPS_EMAIL` | Alert recipient. |
| `acs_sender_address` | tfvars / `vars.ACS_SENDER_ADDRESS` | Must be on the configured `acs_email_domain`. |
| `puretrack_api_key`, `puretrack_email`, `puretrack_password` | `TF_VAR_*` secrets | Sensitive; never written to a tfvars file in CI. |

Optional inputs (`allowed_origins`, `production_hostname`,
`dns_zone_name`/`dns_zone_resource_group_name`, `slack_webhook_url`,
`jwt_secret_version`, `acs_secret_version`, `blob_schema_mode`,
`terraform_principal_type`) have defaults — see
[`variables.tf`](variables.tf) and `../env/<env>.tfvars.example`.

**Precedence note**: `-var-file` values always override `TF_VAR_*`
environment variables for the same variable name. The committed
`<env>.tfvars.example` already has placeholder entries for
`platform_rg_name`, `stamp_rg_name`, `acs_email_domain`, and all three
`puretrack_*` values, so a local apply that both fills those placeholders
in `<env>.tfvars` AND exports the matching `TF_VAR_*` will silently use
the tfvars value. Either fill the tfvars file directly (recommended for
local applies) or remove/comment those specific keys from your local
tfvars before exporting `TF_VAR_*` to test the CI-style path — see
[../README.md](../README.md#first-time-setup) step 5.

## How to run

Preferred — via the manual workflow (uses the env's OIDC UMI). The
workflow's `env` input is currently a fixed `[dev, prod]` choice list (see
`.github/workflows/terraform.yml`) — adding another environment requires
extending that choice list first (a workflow change, out of scope here; see
[../README.md](../README.md#adding-a-new-environment)):

```sh
gh workflow run terraform.yml -f env=dev -f action=plan
gh workflow run terraform.yml -f env=dev -f action=apply
# (or -f env=prod)
```

Locally (needs `az login` with rights on both resource groups; the
`terraform_principal_type=User` override is required for a human principal
— see [../README.md](../README.md#first-time-setup) step 5):

```sh
terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl
terraform -chdir=iac/environment apply -var-file=../env/<env>.tfvars -var 'terraform_principal_type=User'
```

## Outputs

The stamp module's outputs are re-exported at the root: `function_app_name`,
`swa_url`, `storage_account_name`, `key_vault_name`/`key_vault_uri`,
`resource_group_name`, `production_hostname_target`,
`production_dns_managed_by_terraform` — consumed by the app deploy jobs and
operators for DNS cutover.

The platform module's outputs are also re-exported at the root — five in
total: `app_insights_id`, `log_analytics_workspace_id`, `platform_rg_name`,
`acs_email_domain_verification_records`, and `acs_dns_records_for_operator`.
The last two feed ACS domain verification (below); the sensitive
`app_insights_connection_string` output stays internal to the module (it
flows straight into the stamp module's Key Vault copy, never surfaced as a
root output).

## ACS domain verification

After the first apply for an environment, print the registrar records ACS
needs to verify the sending domain:

```sh
terraform -chdir=iac/environment output acs_dns_records_for_operator
```

Add the printed records — `domain_ownership`, `spf`, `dkim`, `dkim2`, and
`dmarc` — at your DNS registrar for the domain set in `acs_email_domain`.
Each value is Azure's record object, including its `type`, `name`, and `value`.
The operator keys map to Azure's raw keys as follows:
`domain_ownership` → `Domain`, `spf` → `SPF`, `dkim` → `DKIM`, `dkim2` →
`DKIM2`, and `dmarc` → `DMARC`; there is no MX record here. Azure
Communication Services polls for the records and flips the domain to
"Verified" once they resolve — no further Terraform action is required.
`acs_email_domain_verification_records` holds that raw Azure-keyed object,
useful for scripting or diffing against a previous apply. There is no
`dmarc_recommended_policy_value` output.

## Secret rotation

Key Vault secret copies are managed by Terraform — bump the version vars
(`jwt_secret_version`, `acs_secret_version`) in the env tfvars (or the
matching GitHub environment variable for CI) and re-apply. See
[../README.md](../README.md#secret-rotation).

## Tests

```sh
terraform -chdir=iac/environment test -test-directory=tests/unit          # mocked, offline
npm run iac:platform-contract                                             # exact platform managed-resource set

terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl
terraform -chdir=iac/environment test -test-directory=tests/integration   # plan-only, real subscription
```
