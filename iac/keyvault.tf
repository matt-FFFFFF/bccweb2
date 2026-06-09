# ─── Key Vault ───────────────────────────────────────────────────────────────
#
# Stores sensitive secrets (e.g. jwt-secret) outside of Terraform state.
# The Function App reads secrets at runtime via @Microsoft.KeyVault(...)
# references, authenticated through its system-assigned managed identity.
#
# OPERATOR NOTE: After the first `terraform apply`, run:
#   scripts/iac/seed-secrets.sh
# to place jwt-secret into the vault. See iac/README.md for full bootstrap
# order. Do NOT create an azurerm_key_vault_secret resource for jwt-secret —
# that would write the plaintext value back into Terraform state.

data "azurerm_client_config" "current" {}

resource "azurerm_key_vault" "main" {
  name                       = "kv-${local.prefix}"
  location                   = azapi_resource.resource_group.location
  resource_group_name        = azapi_resource.resource_group.name
  sku_name                   = "standard"
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  enable_rbac_authorization  = true
  soft_delete_retention_days = 30
  purge_protection_enabled   = true

  tags = local.tags
}

# Grant the Function App's system-assigned managed identity permission to read
# secrets. "Key Vault Secrets User" (4633458b-17de-408a-b874-0445c86b69e6)
# is the least-privilege role — it can GET/LIST secret values but cannot
# manage the vault or other object types.

resource "azurerm_role_assignment" "fn_app_kv_secrets_user" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azapi_resource.function_app.identity[0].principal_id
}
