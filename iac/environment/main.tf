# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Service stack root assembly. Run: terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl && terraform -chdir=iac/environment apply -var-file=../env/<env>.tfvars
#
data "azapi_client_config" "current" {}

# ─── Platform module (per-env LAW + App Insights + ACS email domain) ─────────

module "platform" {
  source = "./modules/platform"

  stamp_name       = var.stamp_name
  location         = var.location
  acs_email_domain = var.acs_email_domain
  platform_rg_name = var.platform_rg_name
  tags             = local.tags
  subscription_id  = data.azapi_client_config.current.subscription_id
}

# ─── Stamp module (single instance — single-stamp by user decision) ───────────

module "stamp" {
  source = "./modules/stamp"

  stamp_name                   = var.stamp_name
  stamp_rg_name                = var.stamp_rg_name
  location                     = var.location
  allowed_origins              = var.allowed_origins
  ops_email                    = var.ops_email
  slack_webhook_url            = var.slack_webhook_url
  production_hostname          = var.production_hostname
  dns_zone_name                = var.dns_zone_name
  dns_zone_resource_group_name = var.dns_zone_resource_group_name
  acs_email_domain_id          = module.platform.acs_email_domain_id
  acs_sender_address           = var.acs_sender_address
  puretrack_api_key            = var.puretrack_api_key
  puretrack_email              = var.puretrack_email
  puretrack_password           = var.puretrack_password
  jwt_secret_version           = var.jwt_secret_version
  acs_secret_version           = var.acs_secret_version
  blob_schema_mode             = var.blob_schema_mode
  tags                         = local.tags

  app_insights_id                = module.platform.app_insights_id
  app_insights_connection_string = module.platform.app_insights_connection_string
  terraform_principal_object_id  = data.azapi_client_config.current.object_id
  terraform_principal_type       = var.terraform_principal_type
}
