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

# Operator-friendly view of the same data: SPF / DKIM / DMARC broken out so the
# DNS runbook can reference each record by name. DMARC value returned by Azure
# is a starter template; publish with `p=none` for first deployment and tighten
# only after at least one week of clean delivery (see acs.tf locals and
# docs/runbooks/dns-cutover.md).
output "acs_email_domain_verification_records" {
  description = "ACS email domain SPF/DKIM/DMARC records broken out by type for the DNS cutover runbook. Each entry is { type, name, value, ttl } or null until the domain is provisioned. The dmarc_recommended_policy_value is what to publish at first cutover (p=none for safety)."
  value = {
    domain                          = azapi_resource.acs_email_domain.name
    domain_ownership                = local.acs_dns_records_for_operator.domain_ownership
    spf                             = local.acs_dns_records_for_operator.spf
    dkim                            = local.acs_dns_records_for_operator.dkim
    dkim2                           = local.acs_dns_records_for_operator.dkim2
    dmarc                           = local.acs_dns_records_for_operator.dmarc
    dmarc_recommended_policy_value  = local.acs_dmarc_recommended_value
  }
}

# ─── Production DNS cutover target (T51) ──────────────────────────────────────
# Stable SWA default hostname the operator points their production CNAME at.

output "production_hostname_target" {
  description = "Stable hostname the production CNAME (var.production_hostname) must point at. Cert-bound to the Static Web App. Paste this as the CNAME target at your DNS registrar, or set var.dns_zone_name to have Terraform manage the record in Azure DNS."
  value       = local.swa_default_host_name
}

output "production_dns_managed_by_terraform" {
  description = "Whether Terraform owns the production CNAME (true when var.dns_zone_name and var.production_hostname are both set). When false, the operator must create the record manually at their registrar — see docs/runbooks/dns-cutover.md."
  value       = local.manage_dns_in_azure
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
