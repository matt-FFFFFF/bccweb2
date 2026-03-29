output "swa_url" {
  description = "Public URL of the Static Web App"
  value       = "https://${azurerm_static_web_app.web.default_host_name}"
}

output "swa_api_key" {
  description = "Deployment token for the Static Web App (used by CI/CD)"
  value       = azurerm_static_web_app.web.api_key
  sensitive   = true
}

output "function_app_name" {
  description = "Name of the Function App (used by CI/CD)"
  value       = azurerm_linux_function_app.api.name
}

output "storage_account_name" {
  description = "Storage account name"
  value       = azurerm_storage_account.main.name
}

output "resource_group_name" {
  description = "Resource group name"
  value       = azurerm_resource_group.main.name
}

# ─── ACS Email DNS records ────────────────────────────────────────────────────
# Add all of these at your domain registrar to verify the sending domain.

output "acs_domain_verification_records" {
  description = "DNS TXT/CNAME records required to verify the ACS sending domain. Add at your registrar."
  value = {
    domain               = azurerm_email_communication_service_domain.main.name
    verification_records = azurerm_email_communication_service_domain.main.verification_records
  }
}

