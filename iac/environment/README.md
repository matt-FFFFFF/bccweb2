# iac/environment — per-env application stack

The application infrastructure for one environment: a single stamp module
that consumes non-secret shared-resource IDs from the `iac/shared` remote
state. See [../README.md](../README.md) for the overall layout.

## Purpose

Composes one [`modules/stamp`](modules/stamp) child module containing the app's
runtime and data storage accounts, Function App, Key Vault (RBAC, 6 secrets),
and alert rules.
The shared root owns Application Insights, ACS, and the Static Web App. The
environment root reads `app_insights_ids`, `acs_id`, and `acs_sender_address`
from shared state; Key Vault fetches both connection strings directly from
those resource IDs.

The stamp resource group is pre-created by
[`iac/bootstrap`](../bootstrap/README.md), which grants the environment's
Terraform UMI Owner on it. The module neither creates nor reads the resource
group.

## Backend

`../env/<env>.backend.hcl` (committed) — state key `<env>.tfstate` in the
bootstrap storage account. Bootstrap's `local_file.backend_config` writes to
this same authoritative path, so committed files and generated files agree —
always use `../env/<env>.backend.hcl`.

## tfvars

`../env/<env>.tfvars` is the committed, tracked, non-secret base (stamp name,
location, CORS origins, secret-version bumps). Secrets and bootstrap-generated
values (`stamp_rg_name`, the `tfstate_*` values, `ops_email`, `puretrack_*`)
live in a gitignored local overlay copied from
`../env/<env>.local.tfvars.example`. Local applies pass the base file first
and the local overlay second so the overlay wins, then append
`-var 'terraform_principal_type=User'` as a CLI override — that variable is
never committed in any tfvars file (see [../README.md](../README.md#first-time-setup) step 6).
CI loads the committed base with `-var-file`; `terraform-run.yml` maps
required GitHub environment variables and secrets explicitly into `TF_VAR_*`
job environment entries (see `.github/workflows/terraform-run.yml`).

## Required inputs

Every apply needs these set (via tfvars locally, or GitHub environment
vars/secrets in CI):

| Variable | Source | Notes |
|---|---|---|
| `stamp_name` | Committed base tfvars (`iac/env/<env>.tfvars`) | Environment name used as the resource-name suffix; authored, not CI-generated. |
| `stamp_rg_name` | `vars.TF_VAR_STAMP_RG_NAME` | Published by bootstrap as a GitHub environment variable. |
| `tfstate_resource_group_name` | `vars.TF_VAR_tfstate_resource_group_name` | Resource group containing the canonical state account. |
| `tfstate_storage_account_name` | `vars.TF_VAR_tfstate_storage_account_name` | Canonical state account containing `tfstate-shared/shared.tfstate`. |
| `ops_email` | tfvars locally / `secrets.TF_VAR_ops_email` in CI | Alert recipient; treated as a Secret, not a Variable, even though it isn't sensitive (public repo). |
| `puretrack_api_key`, `puretrack_email`, `puretrack_password` | `TF_VAR_*` secrets | Sensitive; never written to a tfvars file in CI. |

The ACS sender address is not an environment-root input; it comes from the
shared root's `acs_sender_address` remote-state output.

Optional inputs (`allowed_origins`, `slack_webhook_url`, `jwt_secret_version`,
`acs_secret_version`, `blob_schema_mode`, `terraform_principal_type`) have defaults — see
[`variables.tf`](variables.tf) and `../env/<env>.tfvars.example`.

**Precedence note**: `-var-file` values always override `TF_VAR_*`
environment variables for the same variable name, and a later `-var-file`
overrides an earlier one for the same variable. Passing both the committed
base and the local overlay (base first, overlay second) is the recommended
local path — see [../README.md](../README.md#first-time-setup) step 5.

## How to run

Preferred — via the manual workflow (uses the env's OIDC UMI). The
workflow's `env` input is a `[shared, staging, prod]` choice list (see
`.github/workflows/terraform.yml`) — adding another application environment
requires extending that choice list first (a workflow change, out of scope
here; see [../README.md](../README.md#adding-a-new-environment)):

```sh
gh workflow run terraform.yml -f env=staging -f action=plan
gh workflow run terraform.yml -f env=staging -f action=apply
# (or -f env=prod)
```

Locally (needs `az login` with rights on both resource groups; the CLI
override `-var 'terraform_principal_type=User'` is required for a human
principal — see [../README.md](../README.md#first-time-setup) step 6):

```sh
terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl
terraform -chdir=iac/environment apply -var-file=../env/<env>.tfvars -var-file=../env/<env>.local.tfvars -var 'terraform_principal_type=User'
```

## Outputs

The stamp module's outputs re-exported at the root are exactly
`resource_group_name`, `function_app_name`, `function_app_default_hostname`,
`storage_account_name_runtime`, `storage_account_name_data`,
`key_vault_name`, and `key_vault_uri`.

## ACS domain verification

ACS and its email domain are owned by the shared root. After applying that
root, print the registrar records ACS needs to verify the sending domain:

```sh
terraform -chdir=iac/shared output acs_dns_records_for_operator
```

Add the printed records — `domain_ownership`, `spf`, `dkim`, `dkim2`, and
`dmarc` — at your DNS registrar for the shared ACS email domain.
Each value is Azure's record object, including its `type`, `name`, and `value`.
The operator keys map to Azure's raw keys as follows:
`domain_ownership` → `Domain`, `spf` → `SPF`, `dkim` → `DKIM`, `dkim2` →
`DKIM2`, and `dmarc` → `DMARC`; there is no MX record here. Azure
Communication Services polls for the records and flips the domain to
"Verified" once they resolve — no further Terraform action is required.
The shared root's output contract is documented in
[`../shared/OUTPUTS.md`](../shared/OUTPUTS.md).

## Secret rotation

Key Vault secret copies are managed by Terraform. The stamp reads the shared
Application Insights component to obtain its connection string and calls
`listKeys` ephemerally on the shared ACS resource, so neither value crosses the
shared-state boundary. Bump `jwt_secret_version` or `acs_secret_version` and
re-apply to rotate those copies. See [../README.md](../README.md#secret-rotation).

## Tests

```sh
terraform -chdir=iac/environment test -test-directory=tests/unit          # mocked, offline

terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl
terraform -chdir=iac/environment test -test-directory=tests/integration   # plan-only, real subscription
```
