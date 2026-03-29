# ─── Storage Account ─────────────────────────────────────────────────────────

resource "azurerm_storage_account" "main" {
  name                     = replace("st${local.prefix}", "-", "")
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  account_kind             = "StorageV2"

  # Required to allow container-level and blob-level public access
  allow_nested_items_to_be_public = true

  blob_properties {
    versioning_enabled = false

    # Allow the React SPA (Static Web App) to read public blobs directly
    cors_rule {
      allowed_origins    = ["*"]
      allowed_methods    = ["GET", "HEAD", "OPTIONS"]
      allowed_headers    = ["*"]
      exposed_headers    = ["*"]
      max_age_in_seconds = 86400
    }
  }

  tags = local.tags
}

# ─── Blob Containers ──────────────────────────────────────────────────────────

# Public blob-level access — anonymous GET for any blob in this container.
# Functions still authenticate with the storage connection string for writes.
resource "azurerm_storage_container" "data" {
  name                  = "data"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "blob"
}
