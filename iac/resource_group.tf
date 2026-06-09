resource "azapi_resource" "resource_group" {
  type     = "Microsoft.Resources/resourceGroups@2024-11-01"
  name     = "rg-${local.prefix}"
  location = var.location
  tags     = local.tags
}
