# Root assembly. Run: terraform -chdir=iac init -backend-config=env/<env>.backend.hcl && terraform -chdir=iac apply -var-file=env/<env>.tfvars

data "azapi_client_config" "current" {}

# ─── Platform resource group (shared cross-stamp observability home) ──────────

resource "azapi_resource" "platform" {
  type      = "Microsoft.Resources/resourceGroups@2020-06-01"
  parent_id = "/subscriptions/${data.azapi_client_config.current.subscription_id}"
  name      = "rg-bccweb-platform-${var.stamp_name}"
  location  = var.location

  body = {
    tags = local.tags
  }

  response_export_values = ["id"]
}

# ─── Log Analytics workspace (shared sink for all stamps) ─────────────────────

resource "azapi_resource" "law" {
  type      = "Microsoft.OperationalInsights/workspaces@2025-07-01"
  parent_id = azapi_resource.platform.id
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
  parent_id = azapi_resource.platform.id
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

# ─── Stamp module (single instance — single-stamp by user decision) ───────────

module "stamp" {
  source = "./modules/stamp"

  stamp_name                   = var.stamp_name
  location                     = var.location
  allowed_origins              = var.allowed_origins
  ops_email                    = var.ops_email
  slack_webhook_url            = var.slack_webhook_url
  production_hostname          = var.production_hostname
  dns_zone_name                = var.dns_zone_name
  dns_zone_resource_group_name = var.dns_zone_resource_group_name
  acs_email_domain             = var.acs_email_domain
  acs_sender_address           = var.acs_sender_address
  round_brief_emails           = var.round_brief_emails
  puretrack_api_key            = var.puretrack_api_key
  puretrack_email              = var.puretrack_email
  puretrack_password           = var.puretrack_password
  jwt_secret_version           = var.jwt_secret_version
  acs_secret_version           = var.acs_secret_version
  blob_schema_mode             = var.blob_schema_mode
  tags                         = local.tags

  app_insights_id                = azapi_resource.ai.id
  app_insights_connection_string = azapi_resource.ai.output.properties.ConnectionString
  terraform_principal_object_id  = data.azapi_client_config.current.object_id
  terraform_principal_type       = "ServicePrincipal"
}
