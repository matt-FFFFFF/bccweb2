# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# First-apply may 403 on KV data-plane writes due to RBAC propagation lag. Re-apply to recover. data.azapi_client_config.current is module-local (declared here, reused by rg.tf in the same module).
# kv_admin_role's principalType is switchable via var.terraform_principal_type — "User" for local az login applies, "ServicePrincipal" for UMI/SP applies (CI default).

data "azapi_client_config" "current" {}

data "azapi_resource" "app_insights" {
  type                   = "Microsoft.Insights/components@2020-02-02"
  resource_id            = var.app_insights_id
  response_export_values = ["properties.ConnectionString"]
}

resource "azapi_resource" "kv" {
  type      = "Microsoft.KeyVault/vaults@2026-02-01"
  name      = substr(lower("kv-bccweb-${var.stamp_name}"), 0, 24)
  parent_id = local.stamp_rg_id
  location  = var.location
  tags      = var.tags

  body = {
    properties = {
      sku = {
        name   = "standard"
        family = "A"
      }
      tenantId                  = data.azapi_client_config.current.tenant_id
      enableRbacAuthorization   = true
      enableSoftDelete          = true
      softDeleteRetentionInDays = 30
      enablePurgeProtection     = true
    }
  }

  response_export_values = ["id", "name", "properties.vaultUri"]
}

resource "random_uuid" "kv_admin" {}

resource "azapi_resource" "kv_admin_role" {
  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = random_uuid.kv_admin.result
  parent_id = azapi_resource.kv.id

  body = {
    properties = {
      roleDefinitionId = "/subscriptions/${data.azapi_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
      principalId      = var.terraform_principal_object_id
      principalType    = var.terraform_principal_type
    }
  }
}

resource "random_uuid" "fn_kv_user" {}

resource "azapi_resource" "fn_kv_role" {
  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = random_uuid.fn_kv_user.result
  parent_id = azapi_resource.kv.id

  body = {
    properties = {
      roleDefinitionId = "/subscriptions/${data.azapi_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6"
      principalId      = azapi_resource.fn_umi.output.properties.principalId
      principalType    = "ServicePrincipal"
    }
  }
}

ephemeral "random_password" "jwt" {
  length  = 64
  special = true
}

ephemeral "azapi_resource_action" "acs_keys" {
  type        = "Microsoft.Communication/communicationServices@2025-09-01"
  resource_id = var.acs_id
  action      = "listKeys"
  method      = "POST"

  response_export_values = ["primaryConnectionString"]
}

locals {
  secrets = {
    "jwt-secret"                    = { value = ephemeral.random_password.jwt.result, version = var.jwt_secret_version }
    "acs-connection-string"         = { value = ephemeral.azapi_resource_action.acs_keys.output.primaryConnectionString, version = var.acs_secret_version }
    "appinsights-connection-string" = { value = data.azapi_resource.app_insights.output.properties.ConnectionString, version = "1" }
    "puretrack-api-key"             = { value = var.puretrack_api_key, version = "1" }
    "puretrack-email"               = { value = var.puretrack_email, version = "1" }
    "puretrack-password"            = { value = var.puretrack_password, version = "1" }
  }
}

resource "azapi_data_plane_resource" "secrets" {
  for_each = local.secrets

  type                   = "Microsoft.KeyVault/vaults/secrets@7.4"
  parent_id              = trimsuffix(trimprefix(azapi_resource.kv.output.properties.vaultUri, "https://"), "/")
  name                   = each.key
  sensitive_body         = { value = each.value.value }
  sensitive_body_version = { value = each.value.version }

  depends_on = [azapi_resource.kv_admin_role]
}
