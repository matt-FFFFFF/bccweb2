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

output "key_vault_name" {
  description = "Name of the Key Vault. Used by scripts/iac/seed-secrets.sh to set jwt-secret after first apply."
  value       = azurerm_key_vault.main.name
}

# ─── Application Insights ─────────────────────────────────────────────────────

output "application_insights_name" {
  description = "Name of the Application Insights component (used by T47 alert rules and ad-hoc KQL queries)."
  value       = azurerm_application_insights.main.name
}

output "application_insights_resource_id" {
  description = "Full Azure resource ID of the Application Insights component (alert action group scope)."
  value       = azurerm_application_insights.main.id
}

output "log_analytics_workspace_id" {
  description = "ID of the Log Analytics workspace backing Application Insights."
  value       = azurerm_log_analytics_workspace.main.id
}

# Sensitive: used by scripts/iac/seed-secrets.sh to place the value into Key
# Vault. Marked sensitive so it never appears in plan/apply diff output.
output "application_insights_connection_string" {
  description = "Connection string for the Application Insights component. Consumed only by seed-secrets.sh."
  value       = azurerm_application_insights.main.connection_string
  sensitive   = true
}
