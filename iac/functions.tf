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
            { name = "JWT_SECRET", value = var.jwt_secret },
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
