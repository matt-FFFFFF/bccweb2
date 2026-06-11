# iac — Terraform Infrastructure

This directory manages the Azure resources for bccweb2 using a multi-stamp, declarative approach, split into three stacks: `bootstrap/` (state backend + identities + resource groups), `common/` (per-env observability + email domain), and `service/` (per-env application stamp).

All infrastructure is provisioned using **AzAPI v2.10** with HCL-native bodies.

## Layout

- `bootstrap/`: One-shot config provisioning the remote state storage account, the per-env Terraform UMIs (GitHub OIDC, RG-scoped Owner), the per-env resource groups, and the GitHub environment secrets. See [bootstrap/README.md](bootstrap/README.md).
- `common/`: Per-env Log Analytics workspace + Application Insights + ACS email service/domain, deployed into the bootstrap-created platform RG. See [common/README.md](common/README.md).
- `service/`: Per-env application stamp (storage, Function App, SWA, Key Vault, ACS, alerts, optional DNS), instantiating `service/modules/stamp/` once per environment. Reads common's outputs via remote state. See [service/README.md](service/README.md).
- `env/`: Environment-specific configuration (`<env>.tfvars` + `<env>.backend.hcl` for service; `common-<env>.tfvars` + `common-<env>.backend.hcl` for common).

State ownership: bootstrap owns ALL resource groups; common owns LAW + App Insights + the ACS email service/domain; service owns everything inside the stamp RG. Common and service never create RGs — they reference bootstrap's by interpolated name/ID.

## First-time Setup

Follow these steps to provision a new environment from scratch.

1.  **Authenticate**: Run `az login` to set the subscription context.
2.  **Bootstrap (human-run, one-shot)**:
    See [bootstrap/README.md](bootstrap/README.md) for detailed steps.
    ```bash
    cp iac/bootstrap/terraform.tfvars.example iac/bootstrap/terraform.tfvars
    terraform -chdir=iac/bootstrap init && terraform -chdir=iac/bootstrap apply
    ```
    This creates the env's UMI, two RGs, GitHub environment, and OIDC secrets.
3.  **Prepare Environment Config**:
    Backend files (`iac/env/<env>.backend.hcl`, `iac/env/common-<env>.backend.hcl`) and common tfvars (`iac/env/common-<env>.tfvars`) are committed. For local service applies, create your variables file from the template:
    ```bash
    cp iac/env/dev.tfvars.example iac/env/dev.tfvars
    ```
    Fill in the required placeholders (marked `# REQUIRED`), including `tfstate_sa_name` (the bootstrap `storage_account_name` output). CI does not need this file — the deploy workflows generate it at runtime from GitHub env-scoped vars + secrets.
4.  **Set Sensitive Environment Variables** (local applies only):
    ```bash
    export TF_VAR_puretrack_api_key="your-key"
    export TF_VAR_puretrack_password="your-password"
    # ... and others as defined in dev.tfvars.example
    ```

    **Principal type**: `terraform_principal_type` defaults to `"ServicePrincipal"` because CI (GitHub Actions → per-env Terraform UMI via OIDC, see [bootstrap/README.md](bootstrap/README.md#github-actions-oidc-setup)) is the primary apply path. If you are applying locally as yourself (`az login` as a user), override to `"User"` so the Key Vault Secrets Officer role assignment uses the correct principal type:

    ```bash
    terraform -chdir=iac/service apply -var-file=../env/dev.tfvars -var 'terraform_principal_type=User'
    ```
5.  **Deploy the common stack** (preferred: via workflow; local shown for completeness). First set the real `acs_email_domain` in `iac/env/common-<env>.tfvars`; after the apply, add the registrar DNS records printed by `terraform -chdir=iac/common output acs_dns_records_for_operator`:
    ```bash
    gh workflow run terraform.yml -f stack=common -f env=dev -f mode=apply
    # or locally:
    terraform -chdir=iac/common init -backend-config=../env/common-dev.backend.hcl
    terraform -chdir=iac/common apply -var-file=../env/common-dev.tfvars
    ```
6.  **Deploy the service stack**:
    ```bash
    gh workflow run terraform.yml -f stack=service -f env=dev -f mode=apply
    # or locally:
    terraform -chdir=iac/service init -backend-config=../env/dev.backend.hcl
    terraform -chdir=iac/service apply -var-file=../env/dev.tfvars
    ```
    **Note on RBAC Propagation**: On the very first apply, you might encounter a `403 Forbidden` error when writing secrets to Key Vault. This is caused by Azure RBAC propagation lag. Simply re-run the `apply` to resolve it.

## Secret Rotation

Secrets are managed declaratively. Rotating them involves updating the version variables and re-applying the **service** stack.

-   **JWT Secret**: Bump the `jwt_secret_version` in `env/<env>.tfvars` (e.g., `"1"` → `"2"`). Terraform will generate a new random password and update Key Vault.
-   **ACS Connection String**: Rotate the access key in the Azure portal, then bump `acs_secret_version` in `env/<env>.tfvars`. Terraform will fetch the new key and update Key Vault.
-   **App Insights Connection String**: This string does not rotate. It flows from the common stack's outputs into the service stack via remote state.

## Adding a New Stamp

To add a new environment (e.g., `staging`):

1.  Add a `terraform_umis` entry (+ `github_environments` name) in `iac/bootstrap/terraform.tfvars` and re-apply bootstrap — this creates the env's UMI, both RGs, and GitHub secrets.
2.  Create `iac/env/common-staging.tfvars`, `iac/env/common-staging.backend.hcl`, `iac/env/staging.backend.hcl` (commit all three) and a local `iac/env/staging.tfvars` from the example template.
3.  Run `gh workflow run terraform.yml -f stack=common -f env=staging -f mode=apply`, then the same with `-f stack=service`.

State is isolated per stack × environment within the bootstrap storage account (`common-staging.tfstate`, `staging.tfstate`).

## Tests

-   **Unit Tests**: Mocked provider tests that run quickly without Azure access.
    ```bash
    terraform -chdir=iac/service test -test-directory=tests/unit
    ```
-   **Integration Tests**: Plan-only tests that run against a real subscription.
    ```bash
    terraform -chdir=iac/service test -test-directory=tests/integration -var-file=../env/prod.tfvars
    ```

## Provider Note

This project uses **AzAPI v2.10** for all resource management. The subscription ID is derived automatically from your active `az login` context (or the OIDC session in CI).
