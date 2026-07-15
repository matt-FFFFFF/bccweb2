# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# ─── Production DNS cutover ──────────────────────────────────────────────────

locals {
  manage_dns_in_azure = var.production_hostname != "" && var.dns_zone_name != ""

  dns_zone_resource_group = coalesce(var.dns_zone_resource_group_name, var.dns_zone_name)

  production_cname_record_name = trimsuffix(trimprefix(var.production_hostname, "${var.dns_zone_name}."), ".")
}

resource "azapi_resource" "production_cname" {
  count = local.manage_dns_in_azure ? 1 : 0

  type      = "Microsoft.Network/dnsZones/CNAME@2018-05-01"
  parent_id = "/subscriptions/${data.azapi_client_config.current.subscription_id}/resourceGroups/${local.dns_zone_resource_group}/providers/Microsoft.Network/dnsZones/${var.dns_zone_name}"
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
