# iac/bootstrap — Terraform remote state bootstrap

One-shot Terraform config that provisions the Azure resources backing the
**remote state** and the **CI identities** for the `iac/common/` and
`iac/service/` stacks:

- Bootstrap resource group
- Storage account (StorageV2 + LRS, public blob access disabled, TLS 1.2)
- Blob service with 30-day soft-delete + container soft-delete
- `tfstate` blob container (private)
- `CanNotDelete` management lock on the storage account
- **Per-environment resource groups** (platform + stamp per env) consumed by
  the common and service stacks by interpolated name/ID
- **Per-environment Terraform UMIs** with RG-scoped Owner, GitHub OIDC
  federation, and per-env GitHub Actions secrets

Everything is provisioned via **AzAPI v2.10** with HCL-native bodies (no
JSON-encoded body strings). This config uses **local state** intentionally; see
"Why local state?" below.

> **Migration from single-UMI bootstrap**: if your local state still holds the
> old single `id-bccweb-terraform` UMI with subscription-scope Owner, the next
> apply **DESTROYS** that UMI, its subscription-scope Owner role assignment,
> and its federated credential, replacing them with per-env UMIs. Existing prod RGs
> must be imported first — follow [MIGRATION-OPS.md](MIGRATION-OPS.md) end to
> end before applying.

---

## When to run

- **Once per Azure subscription/region**, before the first `terraform apply` in
  `iac/`.
- Re-run only when you need to recreate the bootstrap RG or rotate to a
  different storage account. The AzAPI resources are idempotent on identical
  bodies — re-applying with the same variables is a no-op.

You **do** re-run this when adding a new environment: add a `terraform_umis`
entry (and the matching `github_environments` name) and re-apply to provision
the env's UMI, its two RGs, and its GitHub secrets. One bootstrap storage
account hosts a tfstate blob per stack × environment (`prod.tfstate`,
`common-prod.tfstate`, `dev.tfstate`, `common-dev.tfstate`, etc.).

## Prerequisites

- Terraform ≥ 1.11.
- `az login` against a principal with Contributor on the target subscription.
- A globally-unique storage account name (3–24 chars, lowercase letters and
  digits only — see `variables.tf`).
- `export GITHUB_TOKEN=<token>` — a GitHub fine-grained PAT with
  Repository permissions **Actions: write**, **Environments: write**, and
  **Secrets: write** on `matt-FFFFFF/bccweb2` (or a classic PAT with the
  `repo` scope). Required only for bootstrap apply when
  `manage_github_secrets = true` (the default). The PAT is **not** used by
  the runtime Function App or by any CI workflow — it only authenticates
  the `integrations/github` provider during this one-shot apply. If you
  cannot supply a token, set `manage_github_secrets = false` and the
  github provider will never be invoked (see "Escape hatch" below).

## How to run

```sh
# 1. Initialise (no backend — local state by design).
terraform -chdir=iac/bootstrap init -backend=false

# 2. Validate.
terraform -chdir=iac/bootstrap validate

# 3. Prepare tfvars. `tfstate_storage_account_name` and `terraform_umis`
#    have no defaults; copy the committed template and adjust.
cp iac/bootstrap/terraform.tfvars.example iac/bootstrap/terraform.tfvars

# 4. Apply. Other variables have sensible defaults (location=uksouth,
#    bootstrap_rg_name=rg-bccweb-tfstate, tfstate_container_name=tfstate).
#    MIGRATING from the single-UMI layout? Run the pre-apply imports in
#    MIGRATION-OPS.md first.
terraform -chdir=iac/bootstrap apply

# 5. Capture the backend config snippet for the downstream stacks.
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

Each stack × env pairing gets its own backend file with a distinct `key`:
`iac/env/<env>.backend.hcl` (service stack, `key = "<env>.tfstate"`) and
`iac/env/common-<env>.backend.hcl` (common stack, `key =
"common-<env>.tfstate"`). Then initialise a stack against its backend:

```sh
terraform -chdir=iac/service init -backend-config=../env/prod.backend.hcl
terraform -chdir=iac/common init -backend-config=../env/common-prod.backend.hcl
```

Both stacks set `backend "azurerm" {}` (empty); all of their config is
supplied at `init` time from these files.

## Outputs

| Output | Description |
|---|---|
| `resource_group_name` | Name of the bootstrap RG holding the tfstate SA. |
| `storage_account_name` | Name of the storage account hosting tfstate blobs. |
| `container_name` | Name of the tfstate blob container. |
| `backend_config_hcl` | Copy-pasteable HCL for `iac/env/<env>.backend.hcl`. |
| `terraform_umi_client_ids` | Map env → app (client) ID of that env's Terraform UMI. Pass as `AZURE_CLIENT_ID` to `azure/login@v3`. Not secrets — OIDC binds each to its federated subject. |
| `terraform_umi_principal_ids` | Map env → object (principal) ID of that env's Terraform UMI. For downstream RBAC. |
| `terraform_umi_resource_ids` | Map env → full Azure resource ID of that env's Terraform UMI. |
| `pre_created_rg_names` | Map `platform-<env>`/`stamp-<env>` → RG name consumed by the common/service stacks. |
| `pre_created_rg_ids` | Map `platform-<env>`/`stamp-<env>` → RG Azure resource ID. |
| `tenant_id` | Azure AD tenant ID. Pass as `AZURE_TENANT_ID`. |
| `subscription_id` | Azure subscription ID. Pass as `AZURE_SUBSCRIPTION_ID`. |
| `github_actions_setup` | Operator runbook (multi-line). Run `terraform -chdir=iac/bootstrap output -raw github_actions_setup` to print. |
| `github_environments_created` | List of GitHub environment names Terraform created/adopted (empty when `manage_github_secrets = false`). |

## GitHub Actions OIDC setup

The bootstrap provisions **one user-assigned managed identity (UMI) per
environment** (`id-bccweb-terraform-dev`, `id-bccweb-terraform-prod`) that
GitHub Actions assumes via OIDC — no client secrets stored anywhere. Each UMI
carries exactly one federated identity credential, scoped to
`repo:<github_repo>:environment:<github_env>` per its `terraform_umis` entry.

**Security note**: Each UMI is granted **RG-scoped Owner** on exactly the two
pre-created resource groups for its environment — never at subscription
scope:

- `id-bccweb-terraform-dev` → Owner on `rg-bccweb-platform-dev` + `rg-bccweb-dev`
- `id-bccweb-terraform-prod` → Owner on `rg-bccweb-platform-prod` + `rg-bccweb-prod`

plus **Storage Blob Data Contributor** on the tfstate storage account (the
azurerm backend uses Azure AD auth). A compromised dev pipeline therefore
cannot touch prod resources and vice versa. Restrict who can edit
`terraform_umis` and `github_repo` — adding an entry grants that GitHub
environment Owner over its named RGs via OIDC.

### Adding a new GitHub environment

Add a `terraform_umis` entry and the matching `github_environments` name in
`iac/bootstrap/terraform.tfvars`, then re-apply:

```hcl
# iac/bootstrap/terraform.tfvars
github_environments = ["dev", "prod", "staging"]

terraform_umis = {
  # ... existing dev + prod entries ...
  staging = {
    platform_rg = "rg-bccweb-platform-staging"
    stamp_rg    = "rg-bccweb-staging"
    github_env  = "staging"
  }
}
```

```sh
terraform -chdir=iac/bootstrap apply
```

The apply creates the env's UMI, federated credential, two RGs, role
assignments, GitHub environment, and secrets in one shot. The federated
subject claim is `repo:<owner/repo>:environment:<name>`, so the
`github_env` value and the GitHub environment name must match exactly
(case-sensitive).

### Pre-apply imports

When migrating from the single-UMI layout, the prod RGs already exist in
Azure (created by the old root `iac/` config). Bootstrap must **adopt** them
before the first apply of the refactored config — otherwise the apply fails
with "resource already exists":

```sh
SUB=$(az account show --query id -o tsv)
terraform -chdir=iac/bootstrap import \
  'azapi_resource.pre_created_rg["platform-prod"]' \
  /subscriptions/$SUB/resourceGroups/rg-bccweb-platform-prod
terraform -chdir=iac/bootstrap import \
  'azapi_resource.pre_created_rg["stamp-prod"]' \
  /subscriptions/$SUB/resourceGroups/rg-bccweb-prod
```

No imports are needed for dev — those RGs do not exist yet and bootstrap
creates them. The full migration sequence (backups, imports, expected plan
delta, verification gates) lives in [MIGRATION-OPS.md](MIGRATION-OPS.md).

### Populate GitHub secrets

When `manage_github_secrets = true` (the default), **Terraform creates the
GitHub environments and pushes the three Azure identifiers as
environment-scoped Actions secrets for you** — no manual paste is required.
The `integrations/github` provider authenticates via the `GITHUB_TOKEN`
environment variable (see Prerequisites). After `terraform -chdir=iac/bootstrap
apply` completes, verify in the GitHub UI at:

```
https://github.com/<owner/repo>/settings/environments/<env>
```

Each environment receives the following secrets — note `AZURE_CLIENT_ID`
**differs per environment** (each env trusts only its own UMI):

| Secret | Source | Per-env? |
|---|---|---|
| `AZURE_CLIENT_ID` | `azapi_resource.tf_umi["<env>"].output.properties.clientId` | **Yes — different value per env** |
| `AZURE_TENANT_ID` | `data.azapi_client_config.current.tenant_id` | No (shared) |
| `AZURE_SUBSCRIPTION_ID` | `data.azapi_client_config.current.subscription_id` | No (shared) |

None of these are real secrets — `clientId` is bound to the federated
subject by OIDC (so even disclosed it cannot be used outside the
permitted GitHub repo+environment), and `tenantId`/`subscriptionId` are
just routing identifiers. GitHub's API still requires them to be
delivered through the secrets channel (encrypted with the environment's
public key before transit) which is what
`github_actions_environment_secret.plaintext_value` does under the hood;
only the ciphertext lands in Terraform state.

The Terraform-managed resource adopts a pre-existing environment with the
same name (idempotent) and `lifecycle.ignore_changes = [reviewers,
deployment_branch_policy]` ensures Terraform will **not** fight any
reviewer or branch-policy settings you configure manually in the GitHub UI
— those remain operator-owned.

#### Escape hatch: `manage_github_secrets = false`

If you cannot supply a `GITHUB_TOKEN` (or want to manage the secrets out of
band), set:

```hcl
# iac/bootstrap/terraform.tfvars
manage_github_secrets = false
```

Or pass `-var 'manage_github_secrets=false'` on the command line. With this
flag, neither `github_repository_environment` nor
`github_actions_environment_secret` is created — the `for_each` evaluates to
an empty set/map and the github provider is never invoked. You still get the
UMIs + federated credentials + RG-scoped Owner grants; just print the
identifiers from the outputs and paste them manually:

```sh
terraform -chdir=iac/bootstrap output -json terraform_umi_client_ids
terraform -chdir=iac/bootstrap output -raw tenant_id
terraform -chdir=iac/bootstrap output -raw subscription_id
```

Add them as **environment-level** secrets (repo-level cannot work — each
environment needs its own clientId):

| Secret | Value |
|---|---|
| `AZURE_CLIENT_ID` | `terraform_umi_client_ids["<env>"]` output (per env) |
| `AZURE_TENANT_ID` | `tenant_id` output |
| `AZURE_SUBSCRIPTION_ID` | `subscription_id` output |

### Workflow requirements

Every job that runs `az` / Terraform must:

```yaml
permissions:
  id-token: write   # required for OIDC token issuance
  contents: read

jobs:
  apply:
    runs-on: ubuntu-latest
    environment: prod   # must match a federated env name
    steps:
      - uses: azure/login@v3
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
```

Without `environment: <name>`, GitHub issues an OIDC token whose `sub` claim
is `repo:<owner/repo>:ref:refs/heads/<branch>` (or similar), which no
federated credential here trusts — `azure/login` will fail with a 400. The
`environment` also selects which env-scoped `AZURE_CLIENT_ID` the job reads,
binding the job to that env's UMI and its RG-scoped permissions.

Print the full operator runbook (including the resolved client-id, tenant-id,
subscription-id, and the list of currently-federated environments):

```sh
terraform -chdir=iac/bootstrap output -raw github_actions_setup
```

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
- The tfstate storage resources (RG, SA, blob service, container, lock) are
  single-instance — no `for_each` / `count`. Per-env fan-out (`for_each`) is
  deliberate and limited to UMIs, federated credentials, pre-created RGs,
  and role assignments keyed by `terraform_umis`.
- No subscription-scoped role assignments — RG-scoped Owner plus
  storage-account-scoped Blob Data Contributor only.
