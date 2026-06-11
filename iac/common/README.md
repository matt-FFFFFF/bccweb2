# iac/common — per-env observability stack

Per-environment Log Analytics + Application Insights, deployed separately
from the service stack so observability survives service-stack churn.
See [../README.md](../README.md) for the overall layout.

## Purpose

Owns the per-env observability resources the service stack consumes. Each
environment gets its own pair (no sharing across envs) so dev telemetry can
never pollute prod and prod retention/sampling can diverge from dev.

## Resources

| Resource | Name | Notes |
|---|---|---|
| Log Analytics workspace | `log-bccweb-<env>` | PerGB2018, 30-day retention |
| Application Insights | `appi-bccweb-<env>` | Workspace-based, 25% sampling |

The platform resource group (`rg-bccweb-platform-<env>`) is **referenced by
interpolated name/ID** — it is pre-created by
[`iac/bootstrap/`](../bootstrap/README.md), never created (or even read) here.

## Backend

`../env/common-<env>.backend.hcl` (committed) — state key `common-<env>.tfstate`
in the bootstrap storage account.

## tfvars

`../env/common-<env>.tfvars` (committed — the common stack has no sensitive
inputs: just `stamp_name`, `location`, optional `tags`).

## How to run

Preferred — via the manual workflow (uses the env's OIDC UMI):

```sh
gh workflow run terraform.yml -f stack=common -f env=<env> -f mode=plan
gh workflow run terraform.yml -f stack=common -f env=<env> -f mode=apply
```

Locally (needs `az login` with rights on the platform RG):

```sh
terraform -chdir=iac/common init -backend-config=../env/common-<env>.backend.hcl
terraform -chdir=iac/common apply -var-file=../env/common-<env>.tfvars
```

## Outputs

Consumed by the service stack via `data.terraform_remote_state.common`
(backend key `common-<env>.tfstate`):

| Output | Used for |
|---|---|
| `app_insights_id` | Alert scopes in the stamp module |
| `app_insights_connection_string` | Key Vault secret feeding the Function App (sensitive) |
| `log_analytics_workspace_id` | Reference/diagnostics |
| `platform_rg_name` | Operator commands |

## Secret rotation

None — LAW and App Insights hold no rotating secrets. The AI connection
string does not rotate; the service stack copies it into Key Vault.
