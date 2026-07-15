# iac/bootstrap — Terraform remote state bootstrap

One-shot Terraform config that provisions the Azure resources backing the
**remote state** and the **CI identities** for the `iac/environment/` stack:

- Bootstrap resource group
- Storage account (StorageV2 + LRS, public blob access disabled, TLS 1.2)
- Blob service with 30-day soft-delete + container soft-delete
- Per-environment `tfstate-<env>` blob containers (private)
- `CanNotDelete` management lock on the storage account
- **Per-environment resource groups** (platform + stamp per env), consumed by
  `iac/environment` as plain inputs (`platform_rg_name`/`stamp_rg_name`) — the
  environment stack never creates or discovers them itself
- **Per-environment Terraform UMIs** with RG-scoped Owner, GitHub OIDC
  federation, and per-env GitHub Actions secrets **and variables** (see
  "Populate GitHub secrets" below for the two non-secret RG-name variables)

Everything is provisioned via **AzAPI v2.10** with HCL-native bodies (no
JSON-encoded body strings). This config uses **local state** intentionally; see
"Why local state?" below.

---

## When to run

- **First time, once per Azure subscription/region**, before the first
  `terraform apply` in `iac/environment`.
- **Re-run whenever the per-environment set changes**: adding a new
  environment (new `terraform_umis` entry + matching `github_environments`
  name — see "Adding a new GitHub environment" below), or backfilling the
  `TF_VAR_PLATFORM_RG_NAME`/`TF_VAR_STAMP_RG_NAME` variables for an
  environment bootstrapped before that publication existed (see "Populate
  GitHub secrets" below). Before every re-apply, save and review a plan.
  Publishing the missing RG-name variables is the required outcome for an
  existing environment, but it may not be the only change: the current
  bootstrap configuration can also reconcile `allowSharedKeyAccess = false`
  and any other pending drift recorded in the plan.
- Also re-run if you need to recreate the bootstrap RG or rotate to a
  different storage account (a rarer, destructive operation — see "Safe
  re-apply / teardown" below).

One bootstrap storage account hosts a tfstate blob container per environment
(`tfstate-prod`, `tfstate-dev`, etc., each holding a `<env>.tfstate` blob) —
there is no separate container per stack, since the platform and stamp
modules now apply together in one state per environment.

## Prerequisites

- Terraform ≥ 1.11.
- `az login` against a principal with **Owner** (or **Contributor** +
  **User Access Administrator**) on the target subscription — this config
  creates `Microsoft.Authorization/roleAssignments` resources (`tf_owner_role`,
  `tf_tfstate_blob_role`, `tf_tfstate_blob_account_reader` in `main.tf`) to
  grant each per-env UMI RG-scoped Owner and Storage Blob Data
  Contributor/Reader; plain **Contributor** alone does NOT include
  `Microsoft.Authorization/roleAssignments/write` and the apply will fail with
  an authorization error on those resources.
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
#    bootstrap_rg_name=rg-bccweb-tfstate, tfstate_container_prefix=tfstate).
terraform -chdir=iac/bootstrap apply

# 5. Display every backend config snippet. The output is a list of strings.
terraform -chdir=iac/bootstrap output -json backend_config_hcl | jq -r '.[]'
```

## Copying outputs into `iac/env/<env>.backend.hcl`

The `backend_config_hcl` output is a list of ready-to-paste strings, one entry
per `github_environments` value. Select the entry for a new environment
`<env>` (for example `staging`) by its generated-file comment:

```sh
env=staging
terraform -chdir=iac/bootstrap output -json backend_config_hcl |
  jq -er --arg env "$env" '.[] | select(contains("iac/env/\($env).backend.hcl"))'
```

Paste the `<env>` entry you need into a committed `iac/env/<env>.backend.hcl`
with `key = "<env>.tfstate"`, then initialise the environment stack against
it:

```sh
terraform -chdir=iac/environment init -backend-config=../env/prod.backend.hcl
```

`iac/environment` sets `backend "azurerm" {}` (empty); all of its backend
config is supplied at `init` time from this file. There is only one backend
file per environment now — the platform and stamp modules apply together in
a single state, so there is no separate `common-<env>.backend.hcl`.

**Known drift (out of scope for this change, do not "fix" by substituting
files)**: the `local_file.backend_config` resource in `main.tf` also writes
a generated snippet straight to `iac/<env>.backend.hcl` (repo root), using a
per-env container name (`tfstate-<env>`) and storage account
`stbccweb13afe`. The **authoritative** files every command and workflow in
this repo actually use are the committed `iac/env/<env>.backend.hcl`, which
instead point at a single shared `tfstate` container in storage account
`stbccwebtfstate813afe` (from commit `810b5a1`, before the per-env-container
change landed here). The two disagree — this is a known branch-level
inconsistency between this module's current output and the committed
`iac/env/` files; it is not resolved by this docs change. Use
`iac/env/<env>.backend.hcl` for every command in this README, not the
root-level generated file.

## Outputs

| Output | Description |
|---|---|
| `resource_group_name` | Name of the bootstrap RG holding the tfstate SA. |
| `storage_account_name` | Name of the storage account hosting tfstate blobs. |
| `container_name` | List of tfstate blob-container names, one per environment. Display with `terraform -chdir=iac/bootstrap output -json container_name | jq -r '.[]'`. |
| `backend_config_hcl` | List of copy-pasteable HCL strings for `iac/env/<env>.backend.hcl`, one per `github_environments` value; select one with the JSON/JQ procedure above. |
| `terraform_umi_client_ids` | Map env → app (client) ID of that env's Terraform UMI. Pass as `AZURE_CLIENT_ID` to `azure/login@v3`. Not secrets — OIDC binds each to its federated subject. |
| `terraform_umi_principal_ids` | Map env → object (principal) ID of that env's Terraform UMI. For downstream RBAC. |
| `terraform_umi_resource_ids` | Map env → full Azure resource ID of that env's Terraform UMI. |
| `pre_created_rg_names` | Map `platform-<env>`/`stamp-<env>` → RG name, also published per-env as the `TF_VAR_PLATFORM_RG_NAME`/`TF_VAR_STAMP_RG_NAME` GitHub environment variables consumed by `iac/environment`. |
| `pre_created_rg_ids` | Map `platform-<env>`/`stamp-<env>` → RG Azure resource ID. |
| `tenant_id` | Azure AD tenant ID. Pass as `AZURE_TENANT_ID`. |
| `subscription_id` | Azure subscription ID. Pass as `AZURE_SUBSCRIPTION_ID`. |
| `github_actions_setup` | Operator runbook (multi-line), including the two published RG-name variables. Run `terraform -chdir=iac/bootstrap output -raw github_actions_setup` to print. |
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

plus **Storage Blob Data Contributor** on its own tfstate container (the
azurerm backend uses Azure AD auth). The RG-scoped Owner grants prevent a dev
pipeline from changing prod workload resources. They do **not** currently
provide state confidentiality: `tf_tfstate_blob_account_reader` grants every
environment UMI Storage Blob Data Reader at the storage-account scope, so a
compromised dev pipeline can read prod state. This is a known unresolved
branch risk; do not claim full dev/prod isolation until that account-level
Reader grant is redesigned. Restrict who can edit `terraform_umis` and
`github_repo` — adding an entry grants that GitHub environment Owner over its
named RGs via OIDC and read access to state in the shared account.

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

### Populate GitHub secrets

When `manage_github_secrets = true` (the default), **Terraform creates the
GitHub environments and pushes the three Azure identifiers as
environment-scoped Actions secrets, plus two RG-name variables, for you** —
no manual paste is required. The `integrations/github` provider
authenticates via the `GITHUB_TOKEN` environment variable (see
Prerequisites). After `terraform -chdir=iac/bootstrap apply` completes,
verify in the GitHub UI at:

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

Each environment also receives two GitHub Actions **variables** (not
secrets — resource group names carry no sensitive value), consumed by
`iac/environment` as `platform_rg_name`/`stamp_rg_name` inputs so CI applies
never have to hand-supply them:

| Variable | Source | Per-env? |
|---|---|---|
| `TF_VAR_PLATFORM_RG_NAME` | `azapi_resource.pre_created_rg["platform-<env>"].name` | **Yes — different RG name per env** |
| `TF_VAR_STAMP_RG_NAME` | `azapi_resource.pre_created_rg["stamp-<env>"].name` | **Yes — different RG name per env** |

None of these are real secrets — `clientId` is bound to the federated
subject by OIDC (so even disclosed it cannot be used outside the
permitted GitHub repo+environment), and `tenantId`/`subscriptionId` are
just routing identifiers. Terraform still delivers them via the
`github_actions_environment_secret.azure` resource's `value` attribute
(the GitHub Actions secrets API, transported over TLS) rather than the
plain `github_actions_environment_variable` resource, because the GitHub
API only accepts environment-scoped `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/
`AZURE_SUBSCRIPTION_ID` through the secrets endpoint. Because bootstrap
uses **local** state (see "Why local state?" below), these plain values —
not the two RG names, which use the separate `github_actions_environment_variable`
resource below and never touch the secrets endpoint — land in this
config's local `terraform.tfstate` unencrypted; that is acceptable only
because none of them are real secrets, per the paragraph above.

The Terraform-managed resource adopts a pre-existing environment with the
same name (idempotent) and `lifecycle.ignore_changes = [reviewers,
deployment_branch_policy]` ensures Terraform will **not** fight any
reviewer or branch-policy settings you configure manually in the GitHub UI
— those remain operator-owned.

**Re-applying against an environment bootstrapped before this variable
publication existed**: `terraform_umis` entries created before
`TF_VAR_PLATFORM_RG_NAME`/`TF_VAR_STAMP_RG_NAME` were added still adopt the
existing GitHub environment (idempotent), but that environment won't have
the two variables yet. Run and review `terraform -chdir=iac/bootstrap plan`
against the same `terraform.tfvars`, then apply the reviewed plan to backfill
them. The two published variables are the required outcome, not a guarantee
that they are the sole changes: the plan may also reconcile
`allowSharedKeyAccess = false` or other pending bootstrap drift.

#### Escape hatch: `manage_github_secrets = false`

If you cannot supply a `GITHUB_TOKEN` (or want to manage the secrets out of
band), set:

```hcl
# iac/bootstrap/terraform.tfvars
manage_github_secrets = false
```

Or pass `-var 'manage_github_secrets=false'` on the command line. With this
flag, neither `github_repository_environment`,
`github_actions_environment_secret`, nor `github_actions_environment_variable`
is created — every `for_each` in that group evaluates to an empty set/map and
the github provider is never invoked. You still get the UMIs + federated
credentials + RG-scoped Owner grants; just print the identifiers from the
outputs and paste them manually:

```sh
terraform -chdir=iac/bootstrap output -json terraform_umi_client_ids
terraform -chdir=iac/bootstrap output -raw tenant_id
terraform -chdir=iac/bootstrap output -raw subscription_id
terraform -chdir=iac/bootstrap output -json pre_created_rg_names
```

Add the first three as **environment-level** secrets (repo-level cannot
work — each environment needs its own clientId) and the RG names as
environment-level **variables**:

| Secret | Value |
|---|---|
| `AZURE_CLIENT_ID` | `terraform_umi_client_ids["<env>"]` output (per env) |
| `AZURE_TENANT_ID` | `tenant_id` output |
| `AZURE_SUBSCRIPTION_ID` | `subscription_id` output |

| Variable | Value |
|---|---|
| `TF_VAR_PLATFORM_RG_NAME` | `pre_created_rg_names["platform-<env>"]` output (per env) |
| `TF_VAR_STAMP_RG_NAME` | `pre_created_rg_names["stamp-<env>"]` output (per env) |

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
  you re-import or `terraform import` the resources this config declares
  (`main.tf`) — the fixed RG/SA/blob-service/lock set plus one entry per
  environment for the tfstate container, UMI, federated credential, and role
  assignments. None require destructive recreation to recover — every AzAPI
  resource here is idempotent and importable by its Azure resource ID.
- The `CanNotDelete` lock on the storage account protects against accidental
  destroy from any source, including a bootstrap re-apply after a state loss.
- All real workload state (`iac/environment` per environment) lives remotely
  in the SA this config creates.

## Safe re-apply / teardown

- Re-running with the same inputs is idempotent, but not guaranteed to be a
  no-op when deployed resources or state differ from the current
  configuration. Always save and review a plan before re-applying; in
  particular, current state may need to reconcile
  `allowSharedKeyAccess = false` alongside RG-variable publication.
- To destroy: first remove the `azapi_resource.tfstate_sa_lock` resource via
  Terraform (or `az lock delete`), then `terraform destroy`. **Doing so will
  irrecoverably delete every remote tfstate blob** — coordinate carefully.

## Guardrails

- No AzureRM provider resources or data sources are used. AzAPI only.
- No JSON-encoded bodies — all HCL-native objects.
- The bootstrap RG, storage account, blob service, and management lock are
  single-instance — no `for_each` / `count`. The tfstate blob **container**
  is per-environment (`azapi_resource.tfstate_container`, `for_each =
  var.github_environments`, named `<tfstate_container_prefix>-<env>`, e.g.
  `tfstate-dev`) — one container per environment inside the single storage
  account, not one shared container. Per-env fan-out (`for_each`) is also
  used for UMIs, federated credentials, pre-created RGs, and role
  assignments keyed by `terraform_umis`.
- No subscription-scoped role assignments — RG-scoped Owner, per-container
  Storage Blob Data Contributor, and the known unresolved account-scoped
  Storage Blob Data Reader grant described in the security note above.
