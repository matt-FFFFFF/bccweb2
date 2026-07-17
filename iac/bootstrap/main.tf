# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Bootstrap configuration for the bccweb2 Terraform remote state backend.
#
# Provisions (one-shot, per Azure subscription/region):
#   * Bootstrap resource group
#   * Storage account hosting per-environment tfstate blob containers
#   * Blob service with 30-day soft-delete
#   * `tfstate-<env>` blob containers (private)
#   * CanNotDelete management lock on the storage account
#   * One shared RG plus one stamp RG per application environment
#   * Per-stack Terraform UMIs with RG-scoped Owner + GitHub OIDC federation
#     + GitHub Actions secrets and deterministic Terraform input variables
#
# Local state is intentional — this config provisions its own remote-state
# target, so it cannot itself live in that target. Re-running is safe; AzAPI
# resources are idempotent on identical bodies.

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
# DISABLED (`allowSharedKeyAccess = false` below) — the `azurerm` backend
# authenticates via Azure AD (`use_azuread_auth = true` in the backend HCL),
# and every UMI/user applying against this account gets Storage Blob Data
# Contributor (or Owner, for the operator running this bootstrap) instead of
# an account key. Public blob access is disabled — tfstate is private.

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
      allowSharedKeyAccess     = false
    }
  }

  response_export_values = ["properties.primaryEndpoints.blob"]
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
  for_each  = var.github_environments
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01"
  name      = join("-", [var.tfstate_container_prefix, each.key])
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

# ─── Pre-created resource groups ─────────────────────────────────────────────
#
# Bootstrap owns the shared RG and every application environment's stamp RG,
# so downstream stacks never need RG-create rights. Shared services live in
# `rg-bccweb-shared`; each application environment gets only `stamp-<env>`.

locals {
  shared_rg_name = "rg-bccweb-shared"
  pre_created_rgs = merge(
    { shared = local.shared_rg_name },
    {
      for env, cfg in var.terraform_umis :
      "stamp-${env}" => cfg.stamp_rg if env != "shared"
    }
  )
}

resource "azapi_resource" "pre_created_rg" {
  for_each = local.pre_created_rgs

  type     = "Microsoft.Resources/resourceGroups@2020-06-01"
  name     = each.value
  location = var.location

  body = {
    tags = {
      project     = "bccweb"
      environment = each.key == "shared" ? "shared" : split("-", each.key)[1]
      managed_by  = "terraform"
    }
  }

  response_export_values = []
}

# ─── Terraform UMIs + GitHub OIDC federated credentials ──────────────────────
#
# One user-assigned managed identity per downstream stack that GitHub Actions
# assumes via OIDC (no client secrets stored anywhere). Each UMI carries one
# federated credential scoped to `repo:<owner/repo>:environment:<github_env>`
# and is granted Owner ONLY on its matching pre-created RG — never at
# subscription scope. Application identities own their stamp RG; the shared
# identity owns the shared RG.

resource "azapi_resource" "tf_umi" {
  for_each = var.terraform_umis

  type      = "Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31"
  name      = "id-bccweb-terraform-${each.key}"
  parent_id = azapi_resource.bootstrap_rg.id
  location  = var.location

  body = {}

  response_export_values = ["id", "properties.principalId", "properties.clientId"]
}

resource "azapi_resource" "tf_umi_fed_cred" {
  for_each = var.terraform_umis

  type      = "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31"
  name      = "github-${each.value.github_env}"
  parent_id = azapi_resource.tf_umi[each.key].id

  body = {
    properties = {
      issuer    = "https://token.actions.githubusercontent.com"
      subject   = "repo:${var.github_repo}:environment:${each.value.github_env}"
      audiences = ["api://AzureADTokenExchange"]
    }
  }
}

# One Owner assignment per (UMI, RG) pair. Role-assignment
# names must be GUIDs; uuidv5 derives a stable one from the pair key so
# re-applies are no-ops (no random provider state involved).
locals {
  umi_rg_owner_pairs = {
    for env, cfg in var.terraform_umis : env => {
      env    = env
      rg_key = env == "shared" ? "shared" : "stamp-${env}"
    }
  }
}

# Owner role definition GUID is a well-known constant — see
# https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#owner
resource "azapi_resource" "tf_owner_role" {
  for_each = local.umi_rg_owner_pairs

  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = uuidv5("url", "bccweb-tf-owner-${each.key}-${azapi_resource.pre_created_rg[each.value.rg_key].id}")
  parent_id = azapi_resource.pre_created_rg[each.value.rg_key].id

  body = {
    properties = {
      roleDefinitionId = "/subscriptions/${data.azapi_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/8e3af657-a8ff-443c-a75c-2fe8c4bcb635"
      principalId      = azapi_resource.tf_umi[each.value.env].output.properties.principalId
      principalType    = "ServicePrincipal"
    }
  }
}

# Each UMI also needs data-plane access to the tfstate blobs (the azurerm
# backend uses Azure AD auth — `use_azuread_auth = true`). Storage Blob Data
# Contributor GUID is a well-known constant — see
# https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#storage-blob-data-contributor
resource "azapi_resource" "tf_tfstate_blob_role" {
  for_each = var.terraform_umis

  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = uuidv5("url", "bccweb-tf-tfstate-blob-${each.key}-${azapi_resource.tfstate_sa.id}")
  parent_id = azapi_resource.tfstate_container[each.value.github_env].id

  body = {
    properties = {
      roleDefinitionId = "/subscriptions/${data.azapi_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe"
      principalId      = azapi_resource.tf_umi[each.key].output.properties.principalId
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

  # GitHub env name → that env's UMI clientId. Every github_environments
  # entry must have a matching terraform_umis entry (indexing fails loudly at
  # plan time otherwise — a deliberate configuration guard).
  env_client_ids = {
    for k, cfg in var.terraform_umis :
    cfg.github_env => azapi_resource.tf_umi[k].output.properties.clientId
  }

  terraform_umi_principal_ids = {
    for k, v in azapi_resource.tf_umi : k => v.output.properties.principalId
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

  # `value` is sent to GitHub's API over TLS (the provider handles that
  # transport-level encryption; it is not something this config does). The
  # values themselves land in this config's LOCAL terraform.tfstate in plain
  # text — that is acceptable because they are not real secrets:
  # clientId/tenantId/subscriptionId are public identifiers (OIDC binds
  # clientId to the federated subject, so disclosure alone is not exploitable
  # outside the permitted GitHub repo+environment).

  value = (
    each.value.name == "AZURE_CLIENT_ID" ? local.env_client_ids[each.value.env] :
    each.value.name == "AZURE_TENANT_ID" ? data.azapi_client_config.current.tenant_id :
    each.value.name == "AZURE_SUBSCRIPTION_ID" ? data.azapi_client_config.current.subscription_id :
    "" # unreachable — local.env_secrets only constructs the three names above
  )

  # Defensive: ensure the RG-scoped Owner + tfstate blob grants land first so
  # that each UMI is fully usable the moment CI reads these secrets.
  depends_on = [azapi_resource.tf_owner_role, azapi_resource.tf_tfstate_blob_role]
}

locals {
  application_umis = {
    for k, cfg in var.terraform_umis : k => cfg if k != "shared"
  }

  # T4 renames dev to staging. Excluding the transitional dev environment here
  # publishes shared-state inputs to prod now and to staging after that rename.
  shared_state_consumers = {
    for k, cfg in local.application_umis : k => cfg if cfg.github_env != "dev"
  }

  github_environment_vars = var.manage_github_secrets ? merge(
    merge([
      for k, cfg in local.application_umis : {
        "${cfg.github_env}/TF_VAR_STAMP_RG_NAME" = { env = cfg.github_env, name = "TF_VAR_STAMP_RG_NAME", value = azapi_resource.pre_created_rg["stamp-${k}"].name }
        "${cfg.github_env}/TF_VAR_stamp_name"    = { env = cfg.github_env, name = "TF_VAR_stamp_name", value = cfg.github_env }
      }
    ]...),
    {
      "shared/TF_VAR_env_umi_principal_ids" = { env = "shared", name = "TF_VAR_env_umi_principal_ids", value = jsonencode(local.terraform_umi_principal_ids) }
      "shared/TF_VAR_shared_rg_name"        = { env = "shared", name = "TF_VAR_shared_rg_name", value = azapi_resource.pre_created_rg["shared"].name }
    },
    merge([
      for k, cfg in local.shared_state_consumers : {
        "${cfg.github_env}/AZURE_LOCATION"                      = { env = cfg.github_env, name = "AZURE_LOCATION", value = var.location }
        "${cfg.github_env}/SHARED_RG_NAME"                      = { env = cfg.github_env, name = "SHARED_RG_NAME", value = azapi_resource.pre_created_rg["shared"].name }
        "${cfg.github_env}/TF_VAR_tfstate_resource_group_name"  = { env = cfg.github_env, name = "TF_VAR_tfstate_resource_group_name", value = azapi_resource.bootstrap_rg.name }
        "${cfg.github_env}/TF_VAR_tfstate_storage_account_name" = { env = cfg.github_env, name = "TF_VAR_tfstate_storage_account_name", value = azapi_resource.tfstate_sa.name }
      }
    ]...)
  ) : {}
}

resource "github_actions_environment_variable" "rg_names" {
  for_each      = local.github_environment_vars
  repository    = split("/", var.github_repo)[1]
  environment   = github_repository_environment.envs[each.value.env].environment
  variable_name = each.value.name
  value         = each.value.value
}

resource "local_file" "backend_config" {
  for_each        = var.github_environments
  filename        = "${path.module}/../env/${each.key}.backend.hcl"
  file_permission = "0644"
  content         = <<-EOT
    # SPDX-FileCopyrightText: 2026 British Club Challenge authors
    # SPDX-License-Identifier: MPL-2.0
    # Generated by iac/bootstrap
    resource_group_name  = "${azapi_resource.bootstrap_rg.name}"
    storage_account_name = "${azapi_resource.tfstate_sa.name}"
    container_name       = "${azapi_resource.tfstate_container[each.key].name}"
    key                  = "${each.key}.tfstate"
    use_azuread_auth     = true
  EOT
}
