# iac/service — per-env application stamp stack

The application infrastructure for one environment, instantiating
[`modules/stamp/`](modules/stamp) once per env. See [../README.md](../README.md)
for the overall layout.

## Purpose

Owns everything inside the stamp resource group: the app's storage, compute,
secrets, email, and alerting. Observability lives in the sibling
[`iac/common/`](../common/README.md) stack; resource groups live in
[`iac/bootstrap/`](../bootstrap/README.md).

## Resources

Storage account (+ lifecycle, locks, containers), Function App (Flex/Linux,
UMI), Static Web App, Key Vault (RBAC, 7 secrets), ACS email (service +
domain), 7 alert rules + ops action group, optional production DNS CNAME.

The stamp resource group (`rg-bccweb-<env>`) is **referenced by interpolated
name/ID** — pre-created by bootstrap, which also grants the env's Terraform
UMI Owner on it; the module never creates or reads the RG itself.

## Backend

`../env/<env>.backend.hcl` (committed) — state key `<env>.tfstate` in the
bootstrap storage account.

## tfvars

`../env/<env>.tfvars` — **gitignored** (holds operator emails + PureTrack
credentials). Local applies: copy `../env/<env>.tfvars.example` and fill in.
CI: the deploy workflows generate the file at runtime from GitHub env-scoped
vars and pass secrets via `TF_VAR_*` environment variables.

## Inputs

From the common stack via `data.terraform_remote_state.common`
(`common-<env>.tfstate`, located through `tfstate_sa_name`/`tfstate_rg_name`):
`app_insights_id` (alert scopes) and `app_insights_connection_string`
(copied into Key Vault for the Function App).

## How to run

Preferred — via the manual workflow (uses the env's OIDC UMI):

```sh
gh workflow run terraform.yml -f stack=service -f env=<env> -f mode=plan
gh workflow run terraform.yml -f stack=service -f env=<env> -f mode=apply
```

Locally (needs `az login` with rights on the stamp RG):

```sh
terraform -chdir=iac/service init -backend-config=../env/<env>.backend.hcl
terraform -chdir=iac/service apply -var-file=../env/<env>.tfvars -var 'terraform_principal_type=User'
```

## Outputs

Consumed by the app deploy jobs and operators: `function_app_name`,
`swa_url`, `storage_account_name`, `key_vault_name`/`key_vault_uri`,
ACS DNS records, and DNS cutover targets.

## Secret rotation

Key Vault secret copies are managed by Terraform — bump the version vars
(`jwt_secret_version`, `acs_secret_version`) in the env tfvars and re-apply.
See [../README.md](../README.md#secret-rotation).

## Tests

```sh
terraform -chdir=iac/service test -test-directory=tests/unit          # mocked, offline
terraform -chdir=iac/service test -test-directory=tests/integration \
  -var-file=../env/<env>.tfvars                                       # plan-only, real subscription
```
