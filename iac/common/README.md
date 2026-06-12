# iac/common — per-env observability + email domain stack

Per-environment Log Analytics + Application Insights + ACS email
service/domain, deployed separately from the service stack so they survive
service-stack churn. See [../README.md](../README.md) for the overall layout.

## Purpose

Owns the per-env resources whose lifecycle must outlive stamp rebuilds:
observability (so telemetry history persists) and the DNS-verified email
domain (so registrar records, the verification wait, and sender reputation
are never repeated when a stamp is recreated). Each environment gets its own
set (no sharing across envs) so dev telemetry/email reputation can never
pollute prod.

## Resources

| Resource | Name | Notes |
|---|---|---|
| Log Analytics workspace | `log-bccweb-<env>` | PerGB2018, 30-day retention |
| Application Insights | `appi-bccweb-<env>` | Workspace-based, 25% sampling |
| ACS email service | `acs-email-bccweb-<env>` | Email channel host (global / Europe data) |
| ACS email domain | `<acs_email_domain>` | CustomerManaged — operator adds registrar DNS records |

The `communicationServices` resource (and its access key → Key Vault flow)
stays in the **service** stack: the key grants send rights on every linked
domain, so keeping it per-stamp preserves env blast-radius isolation.

The platform resource group (`rg-bccweb-platform-<env>`) is **referenced by
interpolated name/ID** — it is pre-created by
[`iac/bootstrap/`](../bootstrap/README.md), never created (or even read) here.

## Backend

`../env/common-<env>.backend.hcl` (committed) — state key `common-<env>.tfstate`
in the bootstrap storage account.

## tfvars

`../env/common-<env>.tfvars` (committed — the common stack has no sensitive
inputs: `stamp_name`, `location`, `acs_email_domain`, optional `tags`).

## Domain verification (one-off per env)

After the first apply, print the registrar records and add them all at your
DNS provider; Azure then marks the domain Verified:

```sh
terraform -chdir=iac/common output acs_dns_records_for_operator
```

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
| `acs_email_domain_id` | Linked to the stamp's `communicationServices` via `linkedDomains` |
| `acs_email_domain_verification_records` / `acs_dns_records_for_operator` | Registrar DNS setup |

## Secret rotation

None — nothing here holds rotating secrets. The AI connection string does
not rotate, and the ACS access key belongs to the service stack's
`communicationServices` resource (rotate there via `acs_secret_version`).
