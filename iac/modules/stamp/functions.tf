locals {
  function_app_settings = [
    { name = "FUNCTIONS_WORKER_RUNTIME", value = "node" },
    { name = "FUNCTIONS_EXTENSION_VERSION", value = "~4" },
    { name = "WEBSITE_NODE_DEFAULT_VERSION", value = "~24" },
    { name = "AzureWebJobsStorage", value = local.storage_primary_connection_string },
    { name = "BLOB_CONNECTION_STRING", value = local.storage_primary_connection_string },
    { name = "BLOB_CONTAINER_NAME", value = "data" },
    { name = "BLOB_PRIVATE_CONTAINER_NAME", value = "data-private" },
    { name = "BLOB_SCHEMA_MODE", value = var.blob_schema_mode },
    { name = "JWT_SECRET", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/jwt-secret/)" },
    { name = "ACS_CONNECTION_STRING", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/acs-connection-string/)" },
    { name = "APPLICATIONINSIGHTS_CONNECTION_STRING", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/appinsights-connection-string/)" },
    { name = "ACS_SENDER_ADDRESS", value = var.acs_sender_address },
    { name = "ROUND_BRIEF_EMAILS", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/round-brief-emails/)" },
    { name = "PURETRACK_API_KEY", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/puretrack-api-key/)" },
    { name = "PURETRACK_EMAIL", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/puretrack-email/)" },
    { name = "PURETRACK_PASSWORD", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/puretrack-password/)" },
  ]
}

resource "azapi_resource" "fn_umi" {
  type      = "Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31"
  name      = "id-bccweb-${var.stamp_name}-fn"
  parent_id = azapi_resource.rg.id
  location  = var.location
  tags      = var.tags

  body = {}

  response_export_values = ["id", "properties.principalId", "properties.clientId"]
}

resource "azapi_resource" "service_plan" {
  type      = "Microsoft.Web/serverfarms@2025-03-01"
  name      = "asp-bccweb-${var.stamp_name}"
  parent_id = azapi_resource.rg.id
  location  = var.location
  tags      = var.tags

  body = {
    kind = "linux"
    sku = {
      name = "Y1"
      tier = "Dynamic"
    }
    properties = {
      reserved = true
    }
  }
}

resource "azapi_resource" "function_app" {
  type      = "Microsoft.Web/sites@2025-03-01"
  name      = "func-bccweb-${var.stamp_name}"
  parent_id = azapi_resource.rg.id
  location  = var.location
  tags      = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azapi_resource.fn_umi.id]
  }

  body = {
    kind = "functionapp,linux"
    properties = {
      serverFarmId              = azapi_resource.service_plan.id
      httpsOnly                 = true
      keyVaultReferenceIdentity = azapi_resource.fn_umi.id
      siteConfig = {
        linuxFxVersion = "NODE|24"
        appSettings    = local.function_app_settings
        cors = {
          allowedOrigins = var.allowed_origins
        }
      }
    }
  }

  response_export_values = ["id", "name", "properties.defaultHostName"]

  lifecycle {
    ignore_changes = [body.properties.siteConfig.cors]
  }
}
