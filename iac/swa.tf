# ─── Static Web App ───────────────────────────────────────────────────────────

resource "azapi_resource" "swa" {
  type      = "Microsoft.Web/staticSites@2022-09-01"
  name      = "swa-${local.prefix}"
  parent_id = azapi_resource.resource_group.id
  location  = azapi_resource.resource_group.location
  tags      = local.tags

  body = {
    sku = {
      name = "Free"
      tier = "Free"
    }
    properties = {}
  }

  response_export_values = ["properties.defaultHostname"]
}

# ─── Static Web App Deployment Token ─────────────────────────────────────────

resource "azapi_resource_action" "swa_secrets" {
  type        = "Microsoft.Web/staticSites@2022-09-01"
  resource_id = azapi_resource.swa.id
  action      = "listSecrets"
  method      = "POST"

  response_export_values = ["properties.apiKey"]
}

locals {
  swa_default_host_name = azapi_resource.swa.output.properties.defaultHostname
  swa_api_key           = azapi_resource_action.swa_secrets.output.properties.apiKey
}
