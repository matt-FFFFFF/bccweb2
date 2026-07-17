# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

locals {
  production_cname_record_name = trimsuffix(trimprefix(var.production_hostname, "${var.dns_zone_name}."), ".")
}

resource "azapi_resource" "production_cname" {
  count = var.production_hostname != "" && var.dns_zone_name != "" ? 1 : 0

  type      = "Microsoft.Network/dnsZones/CNAME@2018-05-01"
  parent_id = "/subscriptions/${local.subscription_id}/resourceGroups/${var.dns_zone_resource_group_name}/providers/Microsoft.Network/dnsZones/${var.dns_zone_name}"
  name      = local.production_cname_record_name

  body = {
    properties = {
      TTL = 3600
      CNAMERecord = {
        cname = azapi_resource.swa.output.properties.defaultHostname
      }
    }
  }
}
