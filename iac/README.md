# iac — Terraform Infrastructure

This directory manages the Azure resources for bccweb2 using a declarative,
two-root layout: `bootstrap/` (one-shot state backend + identities + resource
groups) and `environment/` (the per-environment application stamp, including
observability and email).

All infrastructure is provisioned using **AzAPI v2.10** with HCL-native bodies.

## Layout

- `bootstrap/`: One-shot config provisioning the remote state storage account, the per-env Terraform UMIs (GitHub OIDC, RG-scoped Owner), the two per-env resource groups (platform + stamp), and the GitHub environment secrets/variables. Uses **local state** (it provisions its own remote-state target, so it cannot live there itself). See [bootstrap/README.md](bootstrap/README.md).
- `environment/`: Per-env application stack, composed of two child modules — `modules/platform` (Log Analytics workspace, Application Insights, ACS email service/domain) and `modules/stamp` (storage, Function App, SWA, Key Vault, alerts, optional DNS). One `terraform apply` provisions both for a given environment. See [environment/README.md](environment/README.md).
- `env/`: Environment-specific configuration — `<env>.backend.hcl` (committed) and `<env>.tfvars` (gitignored; copy from the committed `<env>.tfvars.example`).

Bootstrap and the committed backend files use one canonical layout: storage
account `stbccweb13afe`, with one private `tfstate-<env>` container and one
`<env>.tfstate` blob per environment. `local_file.backend_config` writes the
same authoritative `iac/env/<env>.backend.hcl` path used by commands and
workflows. Every backend authenticates with Azure AD; shared-key access is
disabled on the account.

## State ownership

- **Bootstrap**: local state only, by design — it creates the storage account that everything else's remote state lives in.
- **Environment**: one remote state per environment, `<env>.tfstate`, in its own `tfstate-<env>` container in the storage account bootstrap creates. Each environment UMI has Storage Blob Data Contributor on only its own container. The documented `tf_tfstate_blob_account_reader` (does not exist / stale) account-wide grant was never present. There is no shared "common" state anymore — the platform and stamp modules are both planned and applied together, in one state file, by one `terraform apply` against `iac/environment`.

Bootstrap owns every environment's two resource groups (platform + stamp). The environment stack never creates or discovers them itself — it consumes their names as inputs (`platform_rg_name`, `stamp_rg_name`), which bootstrap publishes as GitHub Actions environment **variables** (`TF_VAR_PLATFORM_RG_NAME`, `TF_VAR_STAMP_RG_NAME`) so CI applies pick them up automatically.

## First-time Setup

Follow these steps to provision a new environment from scratch.

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
    env's UMI, its two resource groups, its GitHub environment, the three
    Azure OIDC secrets (`AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_SUBSCRIPTION_ID`),
    and the two RG-name variables (`TF_VAR_PLATFORM_RG_NAME`/`TF_VAR_STAMP_RG_NAME`).
    Without a `GITHUB_TOKEN`, set `manage_github_secrets = false` and wire
    those five values into GitHub manually — see
    [bootstrap/README.md](bootstrap/README.md).

    **Already-bootstrapped `dev`/`prod` environments (pre-collapse)**: if
    this environment was bootstrapped before the `common`/`service` merge,
    its `terraform_umis` entry predates the `TF_VAR_PLATFORM_RG_NAME`/
    `TF_VAR_STAMP_RG_NAME` GitHub variable publication added by this
    change. Before the first merged-stack deployment, save and review an
    `iac/bootstrap` plan, then apply the reviewed plan so those two variables
    get published. Publication is the required outcome, but it may not be the
    sole change: current state can also reconcile
    `allowSharedKeyAccess = false` and other pending bootstrap drift. Then
    continue with step 3 below to set `TF_VAR_ACS_EMAIL_DOMAIN`.
3.  **Set the ACS email domain (operator-set, not published by bootstrap)**:
    Bootstrap does not know your intended email domain, so it cannot publish
    it. Add a GitHub environment variable named `TF_VAR_ACS_EMAIL_DOMAIN` for
    the target environment (repo Settings → Environments → `<env>` → Variables)
    with the real sending domain, e.g. `mail.example.com`. Local applies set
    the same value via `acs_email_domain` in `iac/env/<env>.tfvars`.
4.  **Prepare Environment Config**: the canonical backend file
    (`iac/env/<env>.backend.hcl`) is committed and may also be generated by
    bootstrap at that same path. For local applies, create your variables file
    from the committed template:
    ```bash
    cp iac/env/dev.tfvars.example iac/env/dev.tfvars
    ```
    Fill in the required placeholders (marked `# REQUIRED`), including
    `acs_email_domain`, `puretrack_api_key`, `puretrack_email`, and
    `puretrack_password` — the example template already has entries for
    all of them. CI does not need this file — the `terraform.yml` workflow
    generates it at runtime from GitHub environment vars/secrets.
5.  **Sensitive values — pick one path, don't mix them**: `-var-file`
    assignments always win over `TF_VAR_*` environment variables (Terraform
    applies `-var`/`-var-file` after environment variables), so setting both
    for the same variable silently ignores the exported value. For local
    applies:
    - **Recommended**: just fill the placeholders directly in
      `iac/env/dev.tfvars` from step 4 (`puretrack_api_key`,
      `puretrack_email`, `puretrack_password`, `acs_email_domain`,
      `platform_rg_name`, `stamp_rg_name`) and skip exporting anything.
    - **If you intentionally want to exercise the `TF_VAR_*` path** (e.g. to
      mirror how CI supplies secrets), comment out or delete those specific
      keys from your local `dev.tfvars` first, then export the matching
      `TF_VAR_*` values:
      ```bash
      export TF_VAR_puretrack_api_key="your-key"
      export TF_VAR_puretrack_email="your-email"
      export TF_VAR_puretrack_password="your-password"
      ```

    **Principal type**: `terraform_principal_type` defaults to
    `"ServicePrincipal"` because CI (GitHub Actions → per-env Terraform UMI
    via OIDC, see
    [bootstrap/README.md](bootstrap/README.md#github-actions-oidc-setup)) is
    the primary apply path. Local applies as yourself (`az login` as a
    user) MUST override to `"User"` — the Key Vault Secrets Officer role
    assignment (`keyvault.tf`) uses this to pick the correct
    `principalType`, and it will be wrong for a human principal otherwise.
    Every local `apply`/`plan` command in this document includes
    `-var 'terraform_principal_type=User'` for that reason.
6.  **Deploy the environment stack**:
    ```bash
    gh workflow run terraform.yml -f env=dev -f action=apply
    # or locally:
    terraform -chdir=iac/environment init -backend-config=../env/dev.backend.hcl
    terraform -chdir=iac/environment apply -var-file=../env/dev.tfvars -var 'terraform_principal_type=User'
    ```
    This single apply provisions the platform module (LAW, App Insights, ACS
    email domain) and the stamp module (storage, Function App, SWA, Key
    Vault, alerts) together, in the same plan and the same state.

    After the apply, register the registrar DNS records printed by
    `terraform -chdir=iac/environment output acs_dns_records_for_operator` so
    Azure Communication Services can verify the email domain — see
    [environment/README.md](environment/README.md#acs-domain-verification).

    **Note on RBAC Propagation**: On the very first apply, you might
    encounter a `403 Forbidden` error when writing secrets to Key Vault.
    This is caused by Azure RBAC propagation lag. Simply re-run the apply
    to resolve it.

## Secret Rotation

Secrets are managed declaratively. Rotating them involves updating the version
variables in `iac/env/<env>.tfvars` (or the equivalent GitHub environment
variable for CI) and re-applying `iac/environment`.

-   **JWT Secret**: Bump `jwt_secret_version` (e.g., `"1"` → `"2"`). Terraform generates a new random password and updates Key Vault.
-   **ACS Connection String**: Rotate the access key in the Azure portal, then bump `acs_secret_version`. Terraform fetches the new key and updates Key Vault.
-   **App Insights Connection String**: This string does not rotate. It flows from the environment stack's own `platform` module output into the `stamp` module's Key Vault copy — both inside the same apply, no cross-stack lookup involved.

## Adding a New Environment

To add a new environment (e.g., `staging`):

1.  Add a `terraform_umis` entry (+ the matching `github_environments` name) in `iac/bootstrap/terraform.tfvars` and re-apply bootstrap — this creates the env's UMI, both resource groups, its GitHub environment, and the OIDC secrets + `TF_VAR_PLATFORM_RG_NAME`/`TF_VAR_STAMP_RG_NAME` variables.
2.  Add a GitHub environment variable `TF_VAR_ACS_EMAIL_DOMAIN` for the new environment (see "First-time Setup" step 3 — bootstrap never publishes this one).
3.  Select the new environment's string from the list-valued bootstrap output, then paste it into a committed `iac/env/staging.backend.hcl`:
    ```bash
    env=staging
    terraform -chdir=iac/bootstrap output -json backend_config_hcl |
      jq -er --arg env "$env" '.[] | select(contains("iac/env/\($env).backend.hcl"))'
    ```
    Also commit an `iac/env/staging.tfvars.example` template and create a local `iac/env/staging.tfvars` from it for local applies.
4.  **`terraform.yml`'s `env` input is currently a fixed `[dev, prod]` choice list** (see `.github/workflows/terraform.yml`) — it does not yet support arbitrary environment names. Do NOT try `gh workflow run terraform.yml -f env=staging`; it will be rejected. Adding a third environment to the manual-workflow path requires a workflow-file change (out of scope here — see the deploy workflows' `AGENTS.md`/CI docs). Until that change lands, apply the new environment locally only:
    ```bash
    terraform -chdir=iac/environment init -backend-config=../env/staging.backend.hcl
    terraform -chdir=iac/environment apply -var-file=../env/staging.tfvars -var 'terraform_principal_type=User'
    ```

State is isolated per environment within the bootstrap storage account: each
`<env>.tfstate` blob lives in its own `tfstate-<env>` container. Each environment
UMI has Storage Blob Data Contributor only on that container, so it cannot read
or overwrite another environment's state. The old
`tf_tfstate_blob_account_reader` (does not exist / stale) account-level grant
was a documentation error, not a Terraform resource.

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
