# ─── Production DNS cutover (T51) ─────────────────────────────────────────────
#
# This file SCAFFOLDS the production CNAME from var.production_hostname to the
# Static Web App's default hostname. It is intentionally a no-op when DNS is
# not hosted in Azure: see docs/runbooks/dns-cutover.md for the manual path.
#
# The SWA default hostname (e.g. nice-stone-0a1b2c3d4.azurestaticapps.net) is
# stable across deploys — it is bound to the swa resource, NOT to a per-deploy
# preview environment — so it is safe to use as a long-lived CNAME target.
# See iac/swa.tf (`azapi_resource.swa` + `local.swa_default_host_name`).
#
# Live cutover is an OPERATOR action during the scheduled cutover window. This
# file only places the resource in state. The TTL strategy (lower to 300s 24h
# before cutover, raise back to 3600s 24h after stable) is documented in the
# runbook and enforced by the `ttl` argument below.

locals {
  manage_dns_in_azure = var.dns_zone_name != "" && var.production_hostname != ""

  dns_zone_resource_group = var.dns_zone_resource_group_name != "" ? var.dns_zone_resource_group_name : azapi_resource.resource_group.name

  production_cname_record_name = local.manage_dns_in_azure ? trimsuffix(replace(var.production_hostname, ".${var.dns_zone_name}", ""), ".") : ""
}

resource "azurerm_dns_cname_record" "production" {
  count = local.manage_dns_in_azure ? 1 : 0

  name                = local.production_cname_record_name
  zone_name           = var.dns_zone_name
  resource_group_name = local.dns_zone_resource_group
  ttl                 = 3600
  record              = local.swa_default_host_name
  tags                = local.tags
}
