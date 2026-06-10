# iac — Terraform Infrastructure

This directory manages the Azure resources for bccweb2 using a multi-stamp, declarative approach. It covers the resource group, storage, Function App, Static Web App, ACS email, and Key Vault.

All infrastructure is provisioned using **AzAPI v2.10** with HCL-native bodies.

## Layout

- `bootstrap/`: One-shot config to provision the remote state storage account and container.
- `env/`: Environment-specific configuration files (`<env>.tfvars` and `<env>.backend.hcl`).
- `modules/stamp/`: The core infrastructure module instantiated once per environment.
- `tests/`: Automated tests (unit and integration).
- `main.tf`: Root assembly that instantiates the stamp module.

## First-time Setup

Follow these steps to provision a new environment from scratch.

1.  **Authenticate**: Run `az login` to set the subscription context.
2.  **Bootstrap Remote State**:
    See [iac/bootstrap/README.md](bootstrap/README.md) for detailed steps.
    ```bash
    terraform -chdir=iac/bootstrap init && \
    terraform -chdir=iac/bootstrap apply -var tfstate_storage_account_name=<unique-global-name>
    ```
3.  **Prepare Environment Config**:
    Populate `iac/env/<env>.backend.hcl` using the outputs from the bootstrap step.
    Create your local variables file by copying the template:
    ```bash
    cp iac/env/prod.tfvars.example iac/env/prod.tfvars
    ```
    Open `iac/env/prod.tfvars` and fill in the required placeholders (marked `# REQUIRED`).
4.  **Set Sensitive Environment Variables**:
    Sensitive values like PureTrack credentials should be set as environment variables to avoid committing them to disk.
    ```bash
    export TF_VAR_puretrack_api_key="your-key"
    export TF_VAR_puretrack_password="your-password"
    # ... and others as defined in prod.tfvars.example
    ```

    **Principal type**: `terraform_principal_type` defaults to `"ServicePrincipal"` because CI (GitHub Actions → Terraform UMI via OIDC, see [bootstrap/README.md](bootstrap/README.md#github-actions-oidc-setup)) is the primary apply path. If you are applying locally as yourself (`az login` as a user), override to `"User"` so the Key Vault Secrets Officer role assignment uses the correct principal type:

    ```bash
    # In iac/env/prod.tfvars:
    terraform_principal_type = "User"

    # Or as a one-off override:
    terraform -chdir=iac apply -var-file=env/prod.tfvars -var 'terraform_principal_type=User'
    ```
5.  **Initialize Root Configuration**:
    Connect the root configuration to the remote backend for your specific environment.
    ```bash
    terraform -chdir=iac init -backend-config=env/prod.backend.hcl
    ```
6.  **Apply Infrastructure**:
    ```bash
    terraform -chdir=iac apply -var-file=env/prod.tfvars
    ```
    **Note on RBAC Propagation**: On the very first apply, you might encounter a `403 Forbidden` error when writing secrets to Key Vault. This is caused by Azure RBAC propagation lag. Simply re-run the `apply` command to resolve it.

## Secret Rotation

Secrets are managed declaratively. Rotating them involves updating the version variables in your `tfvars` file and re-applying.

-   **JWT Secret**: Bump the `jwt_secret_version` in `env/<env>.tfvars` (e.g., `"1"` → `"2"`). Terraform will generate a new random password and update Key Vault.
-   **ACS Connection String**: Rotate the access key in the Azure portal, then bump `acs_secret_version` in `env/<env>.tfvars`. Terraform will fetch the new key and update Key Vault.
-   **App Insights Connection String**: This string does not rotate.

## Adding a New Stamp

To add a new environment (e.g., `staging`):

1.  Create `iac/env/staging.tfvars` and `iac/env/staging.backend.hcl`.
2.  Run `terraform -chdir=iac init -backend-config=env/staging.backend.hcl`.
3.  Run `terraform -chdir=iac apply -var-file=env/staging.tfvars`.

State is isolated per environment within the bootstrap storage account.

## Tests

-   **Unit Tests**: Mocked provider tests that run quickly without Azure access.
    ```bash
    terraform -chdir=iac test -test-directory=tests/unit
    ```
-   **Integration Tests**: Plan-only tests that run against a real subscription.
    ```bash
    terraform -chdir=iac test -test-directory=tests/integration -var-file=env/prod.tfvars
    ```

## Provider Note

This project uses **AzAPI v2.10** for all resource management. The subscription ID is derived automatically from your active `az login` context.
