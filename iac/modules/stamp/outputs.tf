output "resource_group_name" {
  description = "Name of the stamp resource group used by root outputs and operator commands."
  value       = azapi_resource.rg.name
}

output "function_app_name" {
  description = "Name of the Function App deployed in the stamp."
  value       = azapi_resource.function_app.name
}

output "function_app_default_hostname" {
  description = "Default hostname of the Function App for API routing and smoke tests."
  value       = azapi_resource.function_app.output.properties.defaultHostName
}

output "swa_default_hostname" {
  description = "Default hostname of the Static Web App for CNAME and site access."
  value       = azapi_resource.swa.output.properties.defaultHostname
}

output "swa_url" {
  description = "Public HTTPS URL of the Static Web App."
  value       = "https://${azapi_resource.swa.output.properties.defaultHostname}"
}

output "storage_account_name" {
  description = "Name of the storage account backing the stamp."
  value       = azapi_resource.storage.name
}

output "key_vault_name" {
  description = "Name of the Key Vault used for stamp secrets."
  value       = azapi_resource.kv.name
}

output "key_vault_uri" {
  description = "Vault URI for applications and bootstrap scripts that read secrets."
  value       = azapi_resource.kv.output.properties.vaultUri
}

output "acs_email_domain_verification_records" {
  description = "ACS email domain verification records formatted for registrar copy."
  value       = local.acs_verification_records
}

output "acs_dns_records_for_operator" {
  description = "ACS DNS records reshaped for operator-friendly runbook copy and paste."
  value       = local.acs_dns_records_for_operator
}

output "production_hostname_target" {
  description = "Target hostname for the production CNAME when DNS is not managed by Terraform."
  value       = local.manage_dns_in_azure ? "" : azapi_resource.swa.output.properties.defaultHostname
}

output "production_dns_managed_by_terraform" {
  description = "Whether Terraform manages the production CNAME record in Azure DNS."
  value       = local.manage_dns_in_azure
}
