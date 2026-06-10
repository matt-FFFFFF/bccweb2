# iac/bootstrap — Terraform remote state bootstrap

One-shot Terraform config that provisions the Azure resources backing the
**remote state** for the root `iac/` configuration:

- Bootstrap resource group
- Storage account (StorageV2 + LRS, public blob access disabled, TLS 1.2)
- Blob service with 30-day soft-delete + container soft-delete
- `tfstate` blob container (private)
- `CanNotDelete` management lock on the storage account

Everything is provisioned via **AzAPI v2.10** with HCL-native bodies (no
JSON-encoded body strings). This config uses **local state** intentionally; see
"Why local state?" below.

---

## When to run

- **Once per Azure subscription/region**, before the first `terraform apply` in
  `iac/`.
- Re-run only when you need to recreate the bootstrap RG or rotate to a
  different storage account. The AzAPI resources are idempotent on identical
  bodies — re-applying with the same variables is a no-op.

You do **not** re-run this for new stamps/environments. One bootstrap storage
account hosts a tfstate blob per environment (`prod.tfstate`, `staging.tfstate`,
etc.).

## Prerequisites

- Terraform ≥ 1.11.
- `az login` against a principal with Contributor on the target subscription.
- A globally-unique storage account name (3–24 chars, lowercase letters and
  digits only — see `variables.tf`).

## How to run

```sh
# 1. Initialise (no backend — local state by design).
terraform -chdir=iac/bootstrap init -backend=false

# 2. Validate.
terraform -chdir=iac/bootstrap validate

# 3. Apply. Supply the unique storage account name; other variables have
#    sensible defaults (location=uksouth, bootstrap_rg_name=rg-bccweb-tfstate,
#    tfstate_container_name=tfstate).
terraform -chdir=iac/bootstrap apply \
  -var 'tfstate_storage_account_name=stbccwebtfstate0001'

# 4. Capture the backend config snippet for the root config.
terraform -chdir=iac/bootstrap output -raw backend_config_hcl
```

## Copying outputs into `iac/env/<env>.backend.hcl`

The `backend_config_hcl` output is a ready-to-paste snippet. For a new
environment `<env>` (e.g. `prod`):

```sh
mkdir -p iac/env
terraform -chdir=iac/bootstrap output -raw backend_config_hcl \
  | sed "s/<env>/prod/g" > iac/env/prod.backend.hcl
```

Then initialise the root config against the remote backend:

```sh
terraform -chdir=iac init -backend-config=env/prod.backend.hcl
```

The root config sets `backend "azurerm" {}` (empty); all of its config is
supplied at `init` time from this file.

## Outputs

| Output | Description |
|---|---|
| `resource_group_name` | Name of the bootstrap RG holding the tfstate SA. |
| `storage_account_name` | Name of the storage account hosting tfstate blobs. |
| `container_name` | Name of the tfstate blob container. |
| `backend_config_hcl` | Copy-pasteable HCL for `iac/env/<env>.backend.hcl`. |

## Why local state?

This configuration provisions its own remote-state target — it cannot itself
live in that target without a chicken-and-egg problem on the very first apply.
Local state for the bootstrap is the standard pattern:

- `iac/bootstrap/terraform.tfstate` is committed-free (gitignored). Lose it and
  you re-import or `terraform import` the four resources — they are trivial and
  small.
- The `CanNotDelete` lock on the storage account protects against accidental
  destroy from any source, including a bootstrap re-apply after a state loss.
- All real workload state (root `iac/`) lives remotely in the SA this config
  creates.

## Safe re-apply / teardown

- Re-running `apply` with the same inputs is a no-op against existing
  resources.
- To destroy: first remove the `azapi_resource.tfstate_sa_lock` resource via
  Terraform (or `az lock delete`), then `terraform destroy`. **Doing so will
  irrecoverably delete every remote tfstate blob** — coordinate carefully.

## Guardrails

- No AzureRM provider resources or data sources are used. AzAPI only.
- No JSON-encoded bodies — all HCL-native objects.
- No `for_each` / `count` on bootstrap resources — single-instance only.
