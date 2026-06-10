resource "azapi_resource" "rg" {
  type                     = "Microsoft.Resources/resourceGroups@2020-06-01"
  name                     = "rg-bccweb-${var.stamp_name}"
  location                 = var.location
  body                     = { tags = var.tags }
  response_export_values    = ["id", "name"]
}
