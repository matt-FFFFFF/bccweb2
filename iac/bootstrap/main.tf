# Bootstrap configuration for the bccweb2 Terraform remote state backend.
#
# Provisions (one-shot, per Azure subscription/region):
#   * Bootstrap resource group
#   * Storage account hosting the tfstate blob container
#   * Blob service with 30-day soft-delete
#   * `tfstate` blob container (private)
#   * CanNotDelete management lock on the storage account
#
# Local state is intentional — this config provisions its own remote-state
# target, so it cannot itself live in that target. Re-running is safe; AzAPI
# resources are idempotent on identical bodies.

terraform {
  required_version = "~> 1.11"

  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.10"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.4"
    }
  }
}

provider "azapi" {}

# The github provider authenticates via the GITHUB_TOKEN env var (default
# behavior). When `manage_github_secrets = false`, every github_* resource is
# gated off, so the provider is never invoked and the token can be absent.
provider "github" {
  owner = split("/", var.github_repo)[0]
}

data "azapi_client_config" "current" {}

# ─── Bootstrap resource group ────────────────────────────────────────────────

resource "azapi_resource" "bootstrap_rg" {
  type     = "Microsoft.Resources/resourceGroups@2020-06-01"
  name     = var.bootstrap_rg_name
  location = var.location

  body = {
    tags = {
      project    = "bccweb"
      purpose    = "tfstate-bootstrap"
      managed_by = "terraform"
    }
  }

  response_export_values = ["id", "name"]
}

# ─── tfstate storage account ─────────────────────────────────────────────────
#
# StorageV2 + LRS is sufficient for tfstate: small, append-style writes; one
# region is fine because the backend is regional anyway. Shared-key access is
# enabled because the `azurerm` backend uses Azure AD when `use_azuread_auth =
# true` is set in the backend HCL but still benefits from shared-key fallback
# for tooling. Public blob access is disabled — tfstate is private.

resource "azapi_resource" "tfstate_sa" {
  type      = "Microsoft.Storage/storageAccounts@2025-06-01"
  name      = var.tfstate_storage_account_name
  parent_id = azapi_resource.bootstrap_rg.id
  location  = var.location

  body = {
    kind = "StorageV2"
    sku = {
      name = "Standard_LRS"
    }
    properties = {
      allowBlobPublicAccess    = false
      minimumTlsVersion        = "TLS1_2"
      supportsHttpsTrafficOnly = true
      allowSharedKeyAccess     = true
    }
  }

  response_export_values = ["id", "name", "properties.primaryEndpoints.blob"]
}

# ─── Blob service (soft delete) ──────────────────────────────────────────────

resource "azapi_update_resource" "tfstate_blob_service" {
  type        = "Microsoft.Storage/storageAccounts/blobServices@2025-06-01"
  resource_id = "${azapi_resource.tfstate_sa.id}/blobServices/default"

  body = {
    properties = {
      deleteRetentionPolicy = {
        enabled = true
        days    = 30
      }
      containerDeleteRetentionPolicy = {
        enabled = true
        days    = 30
      }
    }
  }
}

# ─── tfstate container (private) ─────────────────────────────────────────────

resource "azapi_resource" "tfstate_container" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01"
  name      = var.tfstate_container_name
  parent_id = "${azapi_resource.tfstate_sa.id}/blobServices/default"

  body = {
    properties = {
      publicAccess = "None"
    }
  }

  # The default blob service is implicit — we use azapi_update_resource to
  # customize it without trying to create it. Ensure the update lands before
  # the container is created (containers inherit blob-service properties).
  depends_on = [azapi_update_resource.tfstate_blob_service]
}

# ─── CanNotDelete lock on the storage account ────────────────────────────────
#
# Belt-and-braces: prevents accidental SA deletion (which would destroy the
# tfstate for every environment hosted in it). Operator must remove this lock
# before any deliberate teardown.

resource "azapi_resource" "tfstate_sa_lock" {
  type      = "Microsoft.Authorization/locks@2020-05-01"
  name      = "tfstate-sa-nodelete"
  parent_id = azapi_resource.tfstate_sa.id

  body = {
    properties = {
      level = "CanNotDelete"
      notes = "Protects the Terraform remote state. Remove only for deliberate teardown."
    }
  }

  depends_on = [azapi_resource.tfstate_sa]
}

# ─── Terraform UMI + GitHub OIDC federated credentials ───────────────────────
#
# Single user-assigned managed identity that GitHub Actions assumes via OIDC
# (no client secrets stored anywhere). One federated credential per GitHub
# environment in `var.github_environments`, scoped to
# `repo:<owner/repo>:environment:<env>`. The UMI is granted Owner at
# subscription scope (sub-scope, not RG) so a single identity can manage the
# bootstrap RG + every per-stamp RG the root config creates.

resource "azapi_resource" "tf_umi" {
  type      = "Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31"
  name      = var.terraform_umi_name
  parent_id = azapi_resource.bootstrap_rg.id
  location  = var.location

  body = {}

  response_export_values = ["id", "properties.principalId", "properties.clientId"]
}

resource "azapi_resource" "tf_umi_fed_cred" {
  for_each = toset(var.github_environments)

  type      = "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31"
  name      = "github-${each.key}"
  parent_id = azapi_resource.tf_umi.id

  body = {
    properties = {
      issuer    = "https://token.actions.githubusercontent.com"
      subject   = "repo:${var.github_repo}:environment:${each.key}"
      audiences = ["api://AzureADTokenExchange"]
    }
  }
}

resource "random_uuid" "tf_owner" {}

# Owner role definition GUID is a well-known constant — see
# https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#owner
resource "azapi_resource" "tf_owner_role" {
  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = random_uuid.tf_owner.result
  parent_id = "/subscriptions/${data.azapi_client_config.current.subscription_id}"

  body = {
    properties = {
      roleDefinitionId = "/subscriptions/${data.azapi_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/8e3af657-a8ff-443c-a75c-2fe8c4bcb635"
      principalId      = azapi_resource.tf_umi.output.properties.principalId
      principalType    = "ServicePrincipal"
    }
  }
}

# ─── GitHub repo environments + Azure OIDC secrets ───────────────────────────
#
# Closes the OIDC loop: instead of an operator manually pasting three values
# into GitHub repo/env secrets after bootstrap, Terraform creates one GitHub
# environment per entry in `var.github_environments` and pushes the three
# Azure identifiers as environment-scoped Actions secrets.
#
# Gating: when `manage_github_secrets = false` (operator has no GITHUB_TOKEN
# or wants to manage secrets manually), the for_each evaluates to an empty
# set/map so neither resource is created and the github provider is never
# called (provider config is still loaded but token absence is fine when no
# resources/data sources reference it).
#
# Idempotency: `github_repository_environment` adopts a pre-existing env if
# one exists with the same name. `lifecycle.ignore_changes` covers the
# reviewers + deployment_branch_policy blocks because the operator manages
# those in the GitHub UI (we do not want Terraform fighting their settings).

locals {
  env_secrets = {
    for pair in setproduct(var.github_environments, ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID"]) :
    "${pair[0]}/${pair[1]}" => { env = pair[0], name = pair[1] }
  }
}

resource "github_repository_environment" "envs" {
  for_each = var.manage_github_secrets ? toset(var.github_environments) : toset([])

  repository  = split("/", var.github_repo)[1]
  environment = each.key

  lifecycle {
    ignore_changes = [reviewers, deployment_branch_policy]
  }
}

resource "github_actions_environment_secret" "azure" {
  for_each = var.manage_github_secrets ? local.env_secrets : {}

  repository  = split("/", var.github_repo)[1]
  environment = github_repository_environment.envs[each.value.env].environment
  secret_name = each.value.name

  # plaintext_value is encrypted client-side using the environment's public
  # key before being sent to GitHub; only the ciphertext lands in state. The
  # values themselves are not real secrets — clientId/tenantId/subscriptionId
  # are public identifiers (OIDC binds clientId to the federated subject).
  plaintext_value = (
    each.value.name == "AZURE_CLIENT_ID" ? azapi_resource.tf_umi.output.properties.clientId :
    each.value.name == "AZURE_TENANT_ID" ? data.azapi_client_config.current.tenant_id :
    each.value.name == "AZURE_SUBSCRIPTION_ID" ? data.azapi_client_config.current.subscription_id :
    "" # unreachable — local.env_secrets only constructs the three names above
  )

  # Defensive: ensure the subscription-Owner grant lands first so that the
  # UMI is fully usable the moment CI reads these secrets.
  depends_on = [azapi_resource.tf_owner_role]
}
