# ─── Static Web App ───────────────────────────────────────────────────────────

resource "azurerm_static_web_app" "web" {
  name                = "swa-${local.prefix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku_tier            = "Free"
  sku_size            = "Free"
  tags                = local.tags
}
