# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# ─── Azure Communication Services (ACS) ───────────────────────────────────────
#
# Resources:
#   azapi_resource.acs — ACS base resource (communicationServices)
#
# The email service and its DNS-verified domain live in the `platform` module
# (a sibling child module under `iac/environment`, applied together with this
# `stamp` module in the same plan/state — see iac/environment/main.tf). This
# stamp links the domain by ID via the `linkedDomains`
# property — cross-RG linking within the subscription. The access key grants
# send rights on every linked domain, so the key-holding resource stays
# per-stamp to preserve env blast-radius isolation.
#
# Required module inputs (see variables.tf): acs_email_domain_id,
# acs_sender_address, puretrack_api_key, puretrack_email,
# puretrack_password.
#
# Coordination:
#   * The `ephemeral "azapi_resource_action" "acs_keys"` block lives in
#     keyvault.tf. It is called against azapi_resource.acs.id and used
#     ONLY to write the ACS primary connection string into Key Vault. The
#     Function App reads it back via a Key Vault reference (see
#     iac/environment/modules/stamp/functions.tf). No non-ephemeral listKeys
#     action is declared here, so the raw connection string never lands in
#     state.
#   * Domain verification DNS records are a `platform`-module concern: run
#     `terraform -chdir=iac/environment output acs_dns_records_for_operator`
#     (re-exported by the root — the underlying resource lives in
#     modules/platform, not this stamp module).

locals {
  # Mirrors storage.tf's storage_prefix recomputation: the root module does
  # not pass `prefix` into the stamp module, so each stamp file derives it
  # from var.stamp_name independently.
  acs_prefix = "bccweb-${var.stamp_name}"
}

resource "azapi_resource" "acs" {
  type      = "Microsoft.Communication/communicationServices@2025-09-01"
  name      = "acs-${local.acs_prefix}"
  parent_id = local.stamp_rg_id
  location  = "global"
  tags      = var.tags

  body = {
    properties = {
      dataLocation  = "Europe"
      linkedDomains = [var.acs_email_domain_id]
    }
  }
}
