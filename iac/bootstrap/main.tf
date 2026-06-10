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
  }
}

provider "azapi" {}

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

resource "azapi_resource" "tfstate_blob_service" {
  type      = "Microsoft.Storage/storageAccounts/blobServices@2025-06-01"
  name      = "default"
  parent_id = azapi_resource.tfstate_sa.id

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
  parent_id = azapi_resource.tfstate_blob_service.id

  body = {
    properties = {
      publicAccess = "None"
    }
  }
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
