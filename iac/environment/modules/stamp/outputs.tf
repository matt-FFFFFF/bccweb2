# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
output "resource_group_name" {
  description = "Name of the stamp resource group used by root outputs and operator commands."
  value       = var.stamp_rg_name
}

output "function_app_name" {
  description = "Name of the Function App deployed in the stamp."
  value       = azapi_resource.function_app.name
}

output "function_app_default_hostname" {
  description = "Default hostname of the Function App used when linking the shared Static Web App backend."
  value       = azapi_resource.function_app.output.properties.defaultHostName
}

output "storage_account_name_runtime" {
  description = "Name of the runtime storage account backing Azure Functions and queues."
  value       = azapi_resource.storage_runtime.name
}

output "storage_account_name_data" {
  description = "Name of the data storage account containing application blobs."
  value       = azapi_resource.storage_data.name
}

output "key_vault_name" {
  description = "Name of the Key Vault used for stamp secrets."
  value       = azapi_resource.kv.name
}

output "key_vault_uri" {
  description = "Vault URI for applications and bootstrap scripts that read secrets."
  value       = azapi_resource.kv.output.properties.vaultUri
}
