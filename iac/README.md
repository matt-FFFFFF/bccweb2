# iac — Terraform infrastructure

Manages all Azure resources for bccweb2: resource group, storage, Function App,
Static Web App, ACS email, and Key Vault.

Providers: `Azure/azapi ~> 2.8`, `hashicorp/azurerm ~> 3.0`.
Terraform: `>= 1.10` (pinned to 1.10.5 via `.mise.toml`).

## Bootstrap order (first deploy)

```
1. terraform init
2. terraform apply
3. scripts/iac/seed-secrets.sh
4. Deploy Function App package (CI/CD or az functionapp deployment)
```

Step 3 must run after step 2 because it reads `terraform output -raw key_vault_name`
to locate the vault, then writes `jwt-secret` using the Azure CLI. The Function App
reads the secret at startup via a `@Microsoft.KeyVault(...)` reference resolved
through its system-assigned managed identity. If the secret is absent at startup
the function app will fail to start — always run the seed script before deploying.

## Local development

Copy `apps/api/local.settings.example.json` to `apps/api/local.settings.json` and
set `JWT_SECRET` to any sufficiently long random string. The local Functions host
reads `local.settings.json` directly; Key Vault is not used in local dev.

## Prerequisites

- `az login` with an account that has Contributor on the subscription (for apply)
  and Key Vault Secrets Officer on the vault (for `seed-secrets.sh`)
- `ARM_SUBSCRIPTION_ID` environment variable (required by the azurerm provider in
  some environments; the Azure CLI sets it automatically when there is one
  subscription in context)

## Variables

Copy `terraform.tfvars.example` to `terraform.tfvars` and fill in values.
Sensitive variables (`round_brief_emails`, `puretrack_*`) are better supplied via
`TF_VAR_*` environment variables in CI rather than committed to `terraform.tfvars`.

`jwt_secret` is **not** a Terraform variable — it is seeded out-of-band by
`scripts/iac/seed-secrets.sh` after the first apply.

## Outputs

| Output | Description |
|---|---|
| `swa_url` | Public URL of the Static Web App |
| `swa_api_key` | SWA deployment token (sensitive) |
| `function_app_name` | Function App name (used by CI/CD) |
| `storage_account_name` | Storage account name |
| `resource_group_name` | Resource group name |
| `key_vault_name` | Key Vault name (used by seed-secrets.sh) |
| `acs_domain_verification_records` | DNS records to add at your registrar |

## Secret rotation (jwt-secret)

```bash
# Delete the current version — the function app will fail until the new value
# is in place; rotate during a maintenance window or deploy in blue-green.
az keyvault secret delete \
  --vault-name "$(terraform -chdir=iac output -raw key_vault_name)" \
  --name jwt-secret

# Re-run seed script to generate a new value
scripts/iac/seed-secrets.sh

# Restart the Function App to pick up the new secret
az functionapp restart \
  --name "$(terraform -chdir=iac output -raw function_app_name)" \
  --resource-group "$(terraform -chdir=iac output -raw resource_group_name)"
```
