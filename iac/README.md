# iac — Terraform Infrastructure

This directory manages the Azure resources for bccweb2 using a declarative,
three-root layout: `bootstrap/` (one-shot state backend + identities + resource
groups), `shared/` (the platform layer shared by `staging`/`prod`: Log Analytics,
per-env Application Insights, Azure Communication Services, and the Standard
Static Web App), and `environment/` (the per-environment application stamp).

All infrastructure is provisioned using **AzAPI v2.10** with HCL-native bodies.

## Layout

- `bootstrap/`: One-shot config provisioning the remote state storage account, the per-env Terraform UMIs (GitHub OIDC, RG-scoped Owner), the shared resource group plus one stamp resource group per application environment, and the GitHub environment secrets/variables. Uses **local state** (it provisions its own remote-state target, so it cannot live there itself). See [bootstrap/README.md](bootstrap/README.md).
- `shared/`: The platform layer used by the stable `staging`/`prod` environments — Log Analytics workspace, per-environment Application Insights, Azure Communication Services (email), and one Standard-tier Static Web App (with the production custom domain/DNS). One remote state, `shared.tfstate`. See [shared/README.md](shared/README.md).
- `environment/`: Per-env application stack, composed of a single `modules/stamp` child module (storage — two accounts, see below — Flex Consumption Function App, Key Vault, alerts, optional DNS). It reads only non-secret `app_insights_ids`/`acs_id` from the `shared` root's remote state. One `terraform apply` provisions the stamp for a given environment. See [environment/README.md](environment/README.md).
- `env/`: Committed environment-specific configuration — `<env>.backend.hcl` and non-secret base values in `<env>.tfvars`; secrets are supplied through explicit workflow `TF_VAR_*` environment mappings.

Bootstrap and the committed backend files use one canonical layout: storage
account `stbccweb13afe`, with one private `tfstate-<env>` container and one
`<env>.tfstate` blob per environment (including `tfstate-shared`).
`local_file.backend_config` writes the
same authoritative `iac/env/<env>.backend.hcl` path used by commands and
workflows. Every backend authenticates with Azure AD; shared-key access is
disabled on the account.

## State ownership

- **Bootstrap**: local state only, by design — it creates the storage account that everything else's remote state lives in.
- **Shared**: one remote state, `shared.tfstate`, in `tfstate-shared`. The shared UMI owns that container via Contributor; `staging`/`prod` receive Storage Blob Data Reader on it (read-only remote-state consumption).
- **Environment**: one remote state per environment, `<env>.tfstate`, in its own `tfstate-<env>` container in the storage account bootstrap creates. Each environment UMI has Storage Blob Data Contributor on only its own container. The documented `tf_tfstate_blob_account_reader` (does not exist / stale) account-wide grant was never present.

Bootstrap owns the shared resource group and every environment's stamp resource group. Downstream stacks never create or discover their own resource groups — they consume the names as inputs (`shared_rg_name`, `stamp_rg_name`), which bootstrap publishes as GitHub Actions environment **variables** (`TF_VAR_shared_rg_name`, `TF_VAR_STAMP_RG_NAME`) so CI applies pick them up automatically.

## Storage split (per environment)

Each environment's stamp has **two storage accounts** — infra-only split, no app-code
change (the API still uses one shared `BlobServiceClient` per connection string, so the
public/private containers can't themselves be split across accounts):

- **Account A** `stbccweb<env>rt` — backs `AzureWebJobsStorage`: runtime host storage,
  all ten queues, and the Flex Consumption `deploymentpackage` container.
- **Account B** `stbccweb<env>data` — backs `BLOB_CONNECTION_STRING`: the `data`
  (public) and `data-private` containers.

See [docs/architecture/storage-and-queues.md](../docs/architecture/storage-and-queues.md).

## First-time Setup

Follow these steps to provision the topology from scratch.

1.  **Authenticate**: Run `az login` to set the subscription context.
2.  **Bootstrap (human-run, one-shot)**:
    See [bootstrap/README.md](bootstrap/README.md) for detailed steps.
    ```bash
    cp iac/bootstrap/terraform.tfvars.example iac/bootstrap/terraform.tfvars
    export GITHUB_TOKEN=<a token with Actions/Environments/Secrets: write>
    terraform -chdir=iac/bootstrap init -backend=false
    terraform -chdir=iac/bootstrap apply
    ```
    With the default `manage_github_secrets = true`, this apply creates each
    env's UMI, its resource group(s), its GitHub environment, the three
    Azure OIDC secrets (`AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_SUBSCRIPTION_ID`),
    and the deterministic topology variables (`TF_VAR_shared_rg_name`,
    `TF_VAR_STAMP_RG_NAME`, `TF_VAR_tfstate_resource_group_name`,
    `TF_VAR_tfstate_storage_account_name`, `SHARED_RG_NAME`, `AZURE_LOCATION`).
    Without a `GITHUB_TOKEN`, set `manage_github_secrets = false` and wire
    those values into GitHub manually — see [bootstrap/README.md](bootstrap/README.md).
3.  **Prepare the shared root's local overlay** (`staging`/`prod` share it):
    `iac/env/shared.tfvars` is the committed, tracked base — it already has
    the ACS email domain and empty DNS placeholders filled in; don't
    re-copy the example over it. Bootstrap-generated values
    (`env_umi_principal_ids`, `shared_rg_name`) live in a gitignored local
    overlay. Copy that overlay's template and populate it from bootstrap's
    output:
    ```bash
    cp iac/env/shared.local.tfvars.example iac/env/shared.local.tfvars
    terraform -chdir=iac/bootstrap output -json terraform_umi_principal_ids
    terraform -chdir=iac/bootstrap output -json pre_created_rg_names
    ```
    If your intended ACS email domain differs from the committed
    `acs_email_domain`/`acs_sender_address` in `iac/env/shared.tfvars`, edit
    that committed base file directly (the sender address domain must equal
    `acs_email_domain`). Leave the production hostname/DNS values empty
    until DNS cutover. CI does not use the local overlay; it loads the
    committed base with `-var-file` and maps the generated values from
    GitHub environment variables via `terraform-run.yml` — see
    [shared/README.md](shared/README.md).
4.  **Apply the shared root**:
    ```bash
    terraform -chdir=iac/shared init -backend-config=../env/shared.backend.hcl
    terraform -chdir=iac/shared apply -var-file=../env/shared.tfvars -var-file=../env/shared.local.tfvars
    ```
    This provisions the Log Analytics workspace, per-environment Application
    Insights, Azure Communication Services, and the Standard SWA.
5.  **Prepare the environment root's local overlay**: the canonical backend
    file (`iac/env/<env>.backend.hcl`) is committed and may also be generated
    by bootstrap at that same path. `iac/env/staging.tfvars` is already the
    committed base (stamp name, location, CORS origins, secret-version
    bumps). Secrets and bootstrap-generated values (`stamp_rg_name`, the
    `tfstate_*` values, `ops_email`, `puretrack_*`) live in a gitignored
    local overlay. Copy its template and fill in the required placeholders:
    ```bash
    cp iac/env/staging.local.tfvars.example iac/env/staging.local.tfvars
    ```
    CI loads the committed base file with `-var-file` and supplies the
    equivalent secrets/generated values through explicit `TF_VAR_*`
    job-environment mappings in `terraform-run.yml`; GitHub Secrets cannot be
    read back, so a local overlay is filled by hand.
6.  **Principal type**: `terraform_principal_type` defaults to
    `"ServicePrincipal"` because CI (GitHub Actions → per-env Terraform UMI
    via OIDC, see
    [bootstrap/README.md](bootstrap/README.md#github-actions-oidc-setup)) is
    the primary apply path. Local applies as yourself (`az login` as a
    user) MUST override to `"User"` — the Key Vault Secrets Officer role
    assignment (`keyvault.tf`) uses this to pick the correct
    `principalType`, and it will be wrong for a human principal otherwise.
    The committed `iac/env/<env>.local.tfvars.example` sets
    `terraform_principal_type = "User"` for exactly this reason, so every
    local `iac/environment` apply/plan command in this document that passes
    both var-files needs no separate `-var` override. The shared root has no
    caller-scoped role assignment and needs no such override.
7.  **Deploy the environment stamp**:
    ```bash
    gh workflow run terraform.yml -f env=staging -f action=apply
    # or locally:
    terraform -chdir=iac/environment init -backend-config=../env/staging.backend.hcl
    terraform -chdir=iac/environment apply -var-file=../env/staging.tfvars -var-file=../env/staging.local.tfvars
    ```
    This apply provisions the stamp module (storage — two accounts, Flex
    Consumption Function App, Key Vault, alerts) for the given environment,
    reading Application Insights and ACS identifiers from `iac/shared`'s
    remote state.

    After the shared apply, register the registrar DNS records printed by
    `terraform -chdir=iac/shared output acs_dns_records_for_operator` so
    Azure Communication Services can verify the email domain — see
    [environment/README.md](environment/README.md#acs-domain-verification).

    **Note on RBAC Propagation**: On the very first apply, you might
    encounter a `403 Forbidden` error when writing secrets to Key Vault.
    This is caused by Azure RBAC propagation lag. Simply re-run the apply
    to resolve it.

## Secret Rotation

Secrets are managed declaratively. Rotating them means editing the version
variables in the committed base file, `iac/env/<env>.tfvars`, and re-applying
`iac/environment` — both locally and in CI, since CI loads the same committed
base with `-var-file`. There is no GitHub-variable alternative for these
values; they are authored, non-secret, and live only in the tracked tfvars.

-   **JWT Secret**: Bump `jwt_secret_version` (e.g., `"1"` → `"2"`). Terraform generates a new random password and updates Key Vault.
-   **ACS Connection String**: Rotate the access key in the Azure portal, then bump `acs_secret_version`. Terraform fetches the new key and updates Key Vault.
-   **App Insights Connection String**: This string does not rotate. It flows from the `iac/shared` root's Application Insights output into the stamp's Key Vault copy via a direct `data.azapi_resource` read — no ephemeral cross-stack secret ever crosses the state boundary.

## Adding a New Environment

To add a new application environment (e.g., a second `staging`-like env):

1.  Add a `terraform_umis` entry (+ the matching `github_environments` name) in `iac/bootstrap/terraform.tfvars` and re-apply bootstrap — this creates the env's UMI, its stamp resource group, its GitHub environment, and the OIDC secrets + deterministic `TF_VAR_*` topology variables.
2.  Select the new environment's string from the list-valued bootstrap output, then paste it into a committed `iac/env/<env>.backend.hcl`:
    ```bash
    env=<newenv>
    terraform -chdir=iac/bootstrap output -json backend_config_hcl |
      jq -er --arg env "$env" '.[] | select(contains("iac/env/\($env).backend.hcl"))'
    ```
    Also commit both a non-secret `iac/env/<env>.tfvars` base file and an
    `iac/env/<env>.tfvars.example` full-schema reference, plus a gitignored
    `iac/env/<env>.local.tfvars.example` template documenting the
    secret/generated overlay for local applies.
3.  `terraform.yml`'s `env` input is a `[shared, staging, prod]` choice list (see `.github/workflows/terraform.yml`) — adding a fourth application environment requires extending that choice list (a workflow-file change). Until that lands, apply the new environment locally only:
    ```bash
    cp iac/env/<env>.local.tfvars.example iac/env/<env>.local.tfvars
    terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl
    terraform -chdir=iac/environment apply -var-file=../env/<env>.tfvars -var-file=../env/<env>.local.tfvars
    ```

State is isolated per environment within the bootstrap storage account: each
`<env>.tfstate` blob lives in its own `tfstate-<env>` container. Each environment
UMI has Storage Blob Data Contributor only on that container, so it cannot read
or overwrite another environment's state. The old
`tf_tfstate_blob_account_reader` (does not exist / stale) account-level grant
was a documentation error, not a Terraform resource.

## GitHub Environment Variables & Secrets Contract

Each GitHub environment needs a specific set of `TF_VAR_*` secrets/variables
(for Terraform applies via `terraform-run.yml`) plus, for `staging`/`prod`,
the app-deploy variables `deploy-app.yml` reads. **Bootstrap-published**
entries are written automatically by `iac/bootstrap` (`manage_github_secrets
= true`); **operator-set** entries have no source of truth in Terraform and
must be added manually (repo Settings → Environments → `<env>` →
Variables/Secrets).

**Authored non-secret values are not GitHub entries at all.** Every authored
config value — `production_hostname`, `dns_zone_name`,
`dns_zone_resource_group_name`, `allowed_origins`, `jwt_secret_version`,
`acs_secret_version`, `blob_schema_mode`, `acs_email_domain`,
`acs_sender_address` — lives only in the committed base tfvars
(`iac/env/<env>.tfvars`). Both local applies and CI load that same file with
`-var-file`; there is no GitHub-side duplicate to keep in sync, and rotating
one of these values (e.g. bumping `jwt_secret_version`) means editing the
base file and re-applying, not touching GitHub.

| Name | Kind | Environments | Bootstrap-published or operator-set |
|---|---|---|---|
| `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_SUBSCRIPTION_ID` | Secret | all | Bootstrap-published (OIDC identifiers, not real secrets) |
| `TF_VAR_shared_rg_name` | Variable | `shared` | Bootstrap-published |
| `TF_VAR_env_umi_principal_ids` | Variable | `shared` | Bootstrap-published |
| `TF_VAR_STAMP_RG_NAME` | Variable | `staging`, `prod` | Bootstrap-published (mapped to Terraform's `stamp_rg_name` via `vars.TF_VAR_STAMP_RG_NAME` in `terraform-run.yml`) |
| `TF_VAR_tfstate_resource_group_name` | Variable | `staging`, `prod` | Bootstrap-published |
| `TF_VAR_tfstate_storage_account_name` | Variable | `staging`, `prod` | Bootstrap-published |
| `SHARED_RG_NAME` | Variable | `staging`, `prod` | Bootstrap-published |
| `AZURE_LOCATION` | Variable | `staging`, `prod` | Bootstrap-published |
| `TF_VAR_ops_email` | **Secret** | `staging`, `prod` | Operator-set (public repo — kept as a Secret, not a Variable, even though it isn't sensitive) |
| `TF_VAR_puretrack_api_key`, `TF_VAR_puretrack_email`, `TF_VAR_puretrack_password` | Secret | `staging`, `prod` | Operator-set |
| `TF_VAR_slack_webhook_url` | Secret | `staging`, `prod` | Operator-set (optional, defaulted) |
| `AZURE_FUNCTIONAPP_NAME` | Variable | `staging`, `prod` | Operator-set |
| `VITE_BLOB_BASE_URL` | Variable | `staging`, `prod` | Operator-set |
| `WEB_HOST` | Variable | `prod` | Operator-set (production web hostname for the deploy-app.yml production-domain smoke; set only when a custom domain is enabled) |

Terraform-required-variable validation lives in `terraform-run.yml`'s
"Validate required Terraform variables" step — see that workflow for the
authoritative required-set per root.

## Tests

-   **Unit Tests**: Mocked provider tests that run quickly without Azure access.
    ```bash
    terraform -chdir=iac/environment test -test-directory=tests/unit
    ```
-   **Integration Tests**: Plan-only tests that run against a real subscription (requires `az login` and a backend init for the target environment).
    ```bash
    terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl
    terraform -chdir=iac/environment test -test-directory=tests/integration
    ```

## Provider Note

This project uses **AzAPI v2.10** for all resource management. The subscription ID is derived automatically from your active `az login` context (or the OIDC session in CI).
