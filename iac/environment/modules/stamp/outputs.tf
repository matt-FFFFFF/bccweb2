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
