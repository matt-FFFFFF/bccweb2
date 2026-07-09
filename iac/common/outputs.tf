# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Outputs consumed by the service stack via data.terraform_remote_state.common.

output "app_insights_id" {
  description = "Resource ID of the Application Insights component."
  value       = azapi_resource.ai.id
}

output "app_insights_connection_string" {
  description = "Application Insights connection string, forwarded by the service stack into Key Vault."
  value       = azapi_resource.ai.output.properties.ConnectionString
  sensitive   = true
}

output "log_analytics_workspace_id" {
  description = "Resource ID of the Log Analytics workspace."
  value       = azapi_resource.law.id
}

output "platform_rg_name" {
  description = "Name of the pre-created platform resource group this stack deploys into."
  value       = local.platform_rg_name
}

output "acs_email_domain_id" {
  description = "Resource ID of the ACS email domain. The service stack links it to its communicationServices resource via linkedDomains."
  value       = azapi_resource.acs_email_domain.id
}

output "acs_email_domain_verification_records" {
  description = "Raw ACS domain verification records as returned by Azure."
  value       = local.acs_verification_records
}

output "acs_dns_records_for_operator" {
  description = "ACS DNS records formatted for operator registrar setup (ownership TXT, SPF, DKIM, DKIM2, DMARC)."
  value       = local.acs_dns_records_for_operator
}
