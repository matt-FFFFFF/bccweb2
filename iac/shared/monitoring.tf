# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

resource "azapi_resource" "law" {
  type      = "Microsoft.OperationalInsights/workspaces@2025-07-01"
  parent_id = local.shared_rg_id
  name      = "log-bccweb-shared"
  location  = var.location

  body = {
    tags = local.tags
    properties = {
      sku = {
        name = "PerGB2018"
      }
      retentionInDays = 30
      features = {
        enableLogAccessUsingOnlyResourcePermissions = true
      }
    }
  }

  response_export_values = ["id", "name", "properties.customerId"]

  lifecycle {
    prevent_destroy = true
  }
}

resource "azapi_resource" "ai" {
  for_each = toset(var.environments)

  type      = "Microsoft.Insights/components@2020-02-02"
  parent_id = local.shared_rg_id
  name      = "appi-bccweb-${each.key}"
  location  = var.location

  body = {
    kind = "web"
    tags = local.tags
    properties = {
      Application_Type    = "web"
      WorkspaceResourceId = azapi_resource.law.id
      SamplingPercentage  = 25
    }
  }

  response_export_values = ["id", "name"]

  lifecycle {
    prevent_destroy = true
  }
}

output "app_insights_ids" {
  description = "Application Insights resource IDs keyed by environment."
  value       = { for e, r in azapi_resource.ai : e => r.id }
}

output "log_analytics_workspace_id" {
  description = "Resource ID of the shared Log Analytics workspace."
  value       = azapi_resource.law.id
}
