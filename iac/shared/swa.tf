# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

resource "azapi_resource" "swa" {
  type      = "Microsoft.Web/staticSites@2025-03-01"
  name      = "swa-bccweb-shared"
  parent_id = local.shared_rg_id
  location  = var.swa_location
  tags      = local.tags

  body = {
    sku = {
      name = "Standard"
      tier = "Standard"
    }
    properties = {
      stagingEnvironmentPolicy = "Enabled"
      allowConfigFileUpdates   = true
    }
  }

  response_export_values = ["id", "name", "properties.defaultHostname"]

  lifecycle {
    prevent_destroy = true

    ignore_changes = [
      body.properties.repositoryUrl,
      body.properties.branch,
      body.properties.repositoryToken,
    ]
  }
}

resource "azapi_resource" "swa_custom_domain" {
  count = var.production_hostname != "" && var.dns_zone_name != "" ? 1 : 0

  type      = "Microsoft.Web/staticSites/customDomains@2025-03-01"
  name      = var.production_hostname
  parent_id = azapi_resource.swa.id

  body = {
    properties = {
      validationMethod = "cname-delegation"
    }
  }

  depends_on = [azapi_resource.production_cname]
}

output "swa_name" {
  value = azapi_resource.swa.name
}

output "swa_default_hostname" {
  value = azapi_resource.swa.output.properties.defaultHostname
}

output "swa_id" {
  value = azapi_resource.swa.id
}
