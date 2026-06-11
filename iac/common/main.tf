# Per-env common stack: Log Analytics workspace + Application Insights.
# Run: terraform -chdir=iac/common init -backend-config=../env/common-<env>.backend.hcl && terraform -chdir=iac/common apply -var-file=../env/common-<env>.tfvars
#
# The platform RG is pre-created by iac/bootstrap — this stack never reads or
# manages it; its ID is fully determined by subscription + name, so resources
# just interpolate it. The service stack reads this stack's outputs via
# terraform_remote_state (key common-<env>.tfstate).

data "azapi_client_config" "current" {}

# Tag shape must stay byte-identical to the pre-split root config — the prod
# LAW/AI were imported from it, and any tag delta would break the
# plan-is-no-op migration gate (see iac/STATE-MIGRATION.md).
locals {
  platform_rg_name = "rg-bccweb-platform-${var.stamp_name}"
  platform_rg_id   = "/subscriptions/${data.azapi_client_config.current.subscription_id}/resourceGroups/${local.platform_rg_name}"

  tags = merge(var.tags, {
    project     = "bccweb"
    environment = var.stamp_name
    managed_by  = "terraform"
  })
}

# ─── Log Analytics workspace (per-env sink) ───────────────────────────────────

resource "azapi_resource" "law" {
  type      = "Microsoft.OperationalInsights/workspaces@2025-07-01"
  parent_id = local.platform_rg_id
  name      = "log-bccweb-${var.stamp_name}"
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
}

# ─── Application Insights (workspace-based) ───────────────────────────────────

resource "azapi_resource" "ai" {
  type      = "Microsoft.Insights/components@2020-02-02"
  parent_id = local.platform_rg_id
  name      = "appi-bccweb-${var.stamp_name}"
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

  response_export_values = ["id", "name", "properties.ConnectionString"]
}
