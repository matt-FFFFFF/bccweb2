# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Service stack root assembly. Run: terraform -chdir=iac/service init -backend-config=../env/<env>.backend.hcl && terraform -chdir=iac/service apply -var-file=../env/<env>.tfvars
#
# Observability (LAW + App Insights) lives in the sibling iac/common stack;
# this stack reads its outputs via remote state. The stamp resource group is
# pre-created by iac/bootstrap and consumed inside the stamp module via a
# interpolated ID — this stack creates no resource groups.

data "azapi_client_config" "current" {}

# ─── Common stack outputs (per-env LAW + App Insights) ────────────────────────

data "terraform_remote_state" "common" {
  backend = "azurerm"
  config = {
    resource_group_name  = var.tfstate_rg_name
    storage_account_name = var.tfstate_sa_name
    container_name       = "tfstate"
    key                  = "common-${var.stamp_name}.tfstate"
    use_azuread_auth     = true
  }
}

# ─── Stamp module (single instance — single-stamp by user decision) ───────────

module "stamp" {
  source = "./modules/stamp"

  stamp_name                   = var.stamp_name
  stamp_rg_name                = "rg-bccweb-${var.stamp_name}"
  location                     = var.location
  allowed_origins              = var.allowed_origins
  ops_email                    = var.ops_email
  slack_webhook_url            = var.slack_webhook_url
  production_hostname          = var.production_hostname
  dns_zone_name                = var.dns_zone_name
  dns_zone_resource_group_name = var.dns_zone_resource_group_name
  acs_email_domain_id          = data.terraform_remote_state.common.outputs.acs_email_domain_id
  acs_sender_address           = var.acs_sender_address
  round_brief_emails           = var.round_brief_emails
  puretrack_api_key            = var.puretrack_api_key
  puretrack_email              = var.puretrack_email
  puretrack_password           = var.puretrack_password
  jwt_secret_version           = var.jwt_secret_version
  acs_secret_version           = var.acs_secret_version
  blob_schema_mode             = var.blob_schema_mode
  tags                         = local.tags

  app_insights_id                = data.terraform_remote_state.common.outputs.app_insights_id
  app_insights_connection_string = data.terraform_remote_state.common.outputs.app_insights_connection_string
  terraform_principal_object_id  = data.azapi_client_config.current.object_id
  terraform_principal_type       = var.terraform_principal_type
}
