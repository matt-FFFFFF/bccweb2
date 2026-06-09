output "swa_url" {
  description = "Public URL of the Static Web App"
  value       = "https://${local.swa_default_host_name}"
}

output "swa_api_key" {
  description = "Deployment token for the Static Web App (used by CI/CD)"
  value       = local.swa_api_key
  sensitive   = true
}

output "function_app_name" {
  description = "Name of the Function App (used by CI/CD)"
  value       = azapi_resource.function_app.name
}

output "storage_account_name" {
  description = "Storage account name"
  value       = azapi_resource.storage.name
}

output "resource_group_name" {
  description = "Resource group name"
  value       = azapi_resource.resource_group.name
}

# ─── ACS Email DNS records ────────────────────────────────────────────────────
# Add all of these at your domain registrar to verify the sending domain.

output "acs_domain_verification_records" {
  description = "DNS TXT/CNAME records required to verify the ACS sending domain. Add at your registrar."
  value = {
    domain               = azapi_resource.acs_email_domain.name
    verification_records = azapi_resource.acs_email_domain.output.properties.verificationRecords
  }
}
