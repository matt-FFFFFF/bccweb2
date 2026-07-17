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

output "storage_account_name_runtime" {
  description = "Name of the runtime storage account."
  value       = module.stamp.storage_account_name_runtime
}

output "storage_account_name_data" {
  description = "Name of the application data storage account."
  value       = module.stamp.storage_account_name_data
}

output "key_vault_name" {
  description = "Name of the Key Vault."
  value       = module.stamp.key_vault_name
}

output "key_vault_uri" {
  description = "Vault URI for applications and scripts that read secrets."
  value       = module.stamp.key_vault_uri
}
