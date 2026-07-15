# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
output "resource_group_name" {
  description = "Name of the stamp resource group."
  value       = module.stamp.resource_group_name
}

output "function_app_name" {
  description = "Name of the Function App."
  value       = module.stamp.function_app_name
}

output "swa_url" {
  description = "Public HTTPS URL of the Static Web App."
  value       = module.stamp.swa_url
}

output "storage_account_name" {
  description = "Name of the storage account."
  value       = module.stamp.storage_account_name
}

output "key_vault_name" {
  description = "Name of the Key Vault."
  value       = module.stamp.key_vault_name
}

output "key_vault_uri" {
  description = "Vault URI for applications and scripts that read secrets."
  value       = module.stamp.key_vault_uri
}

output "production_hostname_target" {
  description = "Target hostname for the production CNAME."
  value       = module.stamp.production_hostname_target
}

output "production_dns_managed_by_terraform" {
  description = "Whether Terraform manages the production DNS record."
  value       = module.stamp.production_dns_managed_by_terraform
}

output "app_insights_id" {
  description = "Resource ID of the Application Insights component."
  value       = module.platform.app_insights_id
}

output "log_analytics_workspace_id" {
  description = "Resource ID of the Log Analytics workspace."
  value       = module.platform.log_analytics_workspace_id
}

output "platform_rg_name" {
  description = "Name of the pre-created platform resource group."
  value       = module.platform.platform_rg_name
}

output "acs_email_domain_verification_records" {
  description = "Raw ACS domain verification records as returned by Azure."
  value       = module.platform.acs_email_domain_verification_records
}

output "acs_dns_records_for_operator" {
  description = "ACS DNS records formatted for operator registrar setup."
  value       = module.platform.acs_dns_records_for_operator
}
