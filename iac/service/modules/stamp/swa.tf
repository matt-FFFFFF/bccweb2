resource "azapi_resource" "swa" {
  type      = "Microsoft.Web/staticSites@2025-03-01"
  name      = "swa-bccweb-${var.stamp_name}"
  parent_id = local.stamp_rg_id
  location  = var.location

  body = {
    sku = {
      name = "Free"
      tier = "Free"
    }
    properties = {}
  }

  response_export_values = ["id", "name", "properties.defaultHostname"]

  lifecycle {
    ignore_changes = [
      body.properties.repositoryUrl,
      body.properties.branch,
      body.properties.repositoryToken,
    ]
  }
}

locals {
  swa_default_host_name = azapi_resource.swa.output.properties.defaultHostname
}
