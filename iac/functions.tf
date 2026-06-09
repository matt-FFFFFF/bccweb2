# ─── Consumption Plan (Y1 / Linux) ───────────────────────────────────────────

resource "azapi_resource" "service_plan" {
  type      = "Microsoft.Web/serverfarms@2022-09-01"
  name      = "asp-${local.prefix}-fn"
  parent_id = azapi_resource.resource_group.id
  location  = azapi_resource.resource_group.location
  tags      = local.tags

  body = {
    kind = "linux"
    sku = {
      name = "Y1"
      tier = "Dynamic"
    }
    properties = {
      reserved = true # required for Linux
    }
  }
}

# ─── Function App ─────────────────────────────────────────────────────────────

resource "azapi_resource" "function_app" {
  type      = "Microsoft.Web/sites@2022-09-01"
  name      = "func-${local.prefix}"
  parent_id = azapi_resource.resource_group.id
  location  = azapi_resource.resource_group.location
  tags      = local.tags

  identity {
    type = "SystemAssigned"
  }

  body = {
    kind = "functionapp,linux"
    properties = {
      serverFarmId = azapi_resource.service_plan.id
      siteConfig = {
        linuxFxVersion = "NODE|20"
        appSettings = concat(
          [
            { name = "FUNCTIONS_WORKER_RUNTIME", value = "node" },
            { name = "FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR", value = "true" },
            { name = "WEBSITE_RUN_FROM_PACKAGE", value = "1" },
            { name = "AzureWebJobsStorage", value = local.storage_primary_connection_string },
            { name = "BLOB_CONNECTION_STRING", value = local.storage_primary_connection_string },
            { name = "BLOB_CONTAINER_NAME", value = azapi_resource.storage_container_data.name },
            { name = "BLOB_PRIVATE_CONTAINER_NAME", value = azapi_resource.storage_container_data_private.name },
            # JWT_SECRET is read at runtime from Key Vault via the Function App's
            # system-assigned managed identity. Never store the plaintext value here.
            # Seed the secret after first apply: scripts/iac/seed-secrets.sh
            { name = "JWT_SECRET", value = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.main.name};SecretName=jwt-secret)" },

            # Application Insights wiring (T46).
            # Connection string lives in Key Vault — seeded by scripts/iac/seed-secrets.sh.
            # Auto-instrumentation (ApplicationInsightsAgent_EXTENSION_VERSION=~3) attaches
            # the AI Node agent during cold start; APPINSIGHTS_PROFILERFEATURE_VERSION=1.0.0
            # enables the always-on profiler. Server-side sampling is also set on the AI
            # resource itself (sampling_percentage = 25 in insights.tf); the env var here
            # is the SDK-side fallback used by manual track* calls in apps/api/src/lib/telemetry.ts.
            { name = "APPLICATIONINSIGHTS_CONNECTION_STRING", value = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.main.name};SecretName=appinsights-connection-string)" },
            { name = "ApplicationInsightsAgent_EXTENSION_VERSION", value = "~3" },
            { name = "APPINSIGHTS_PROFILERFEATURE_VERSION", value = "1.0.0" },
            { name = "APPINSIGHTS_SAMPLING_PERCENTAGE", value = "25" },
          ],
          local.acs_app_settings_list
        )
        cors = {
          allowedOrigins = [
            "https://${local.swa_default_host_name}"
          ]
        }
      }
    }
  }

  response_export_values = ["name"]
}
