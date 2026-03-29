# ─── Consumption Plan (Y1 / Linux) ───────────────────────────────────────────

resource "azurerm_service_plan" "functions" {
  name                = "asp-${local.prefix}-fn"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = "Y1"
  tags                = local.tags
}

# ─── Function App ─────────────────────────────────────────────────────────────

resource "azurerm_linux_function_app" "api" {
  name                       = "func-${local.prefix}"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  service_plan_id            = azurerm_service_plan.functions.id
  storage_account_name       = azurerm_storage_account.main.name
  storage_account_access_key = azurerm_storage_account.main.primary_access_key

  site_config {
    application_stack {
      node_version = "20"
    }
    cors {
      allowed_origins = [
        "https://${azurerm_static_web_app.web.default_host_name}"
      ]
    }
  }

  app_settings = merge(
    {
      FUNCTIONS_WORKER_RUNTIME                  = "node"
      FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR = "true"
      WEBSITE_RUN_FROM_PACKAGE                  = "1"
      BLOB_CONNECTION_STRING                    = azurerm_storage_account.main.primary_connection_string
      BLOB_CONTAINER_NAME                       = azurerm_storage_container.data.name
      JWT_SECRET                                = var.jwt_secret
    },
    local.acs_app_settings
  )

  tags = local.tags
}
