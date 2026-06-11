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
