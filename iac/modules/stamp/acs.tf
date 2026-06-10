# ─── Azure Communication Services (ACS) — Email ───────────────────────────────
#
# Resources:
#   azapi_resource.acs              — ACS base resource
#   azapi_resource.acs_email        — Email channel
#   azapi_resource.acs_email_domain — CustomerManaged domain (requires DNS)
#
# The email domain is linked to the ACS service via the `linkedDomains`
# property on the communicationServices resource (no separate association
# resource needed with azapi).
#
# Required module inputs (see variables.tf): acs_email_domain,
# acs_sender_address, round_brief_emails, puretrack_api_key, puretrack_email,
# puretrack_password.
#
# Coordination:
#   * The `ephemeral "azapi_resource_action" "acs_keys"` block lives in
#     keyvault.tf (T10). It is called against azapi_resource.acs.id and used
#     ONLY to write the ACS primary connection string into Key Vault. The
#     Function App reads it back via a Key Vault reference (see
#     local.acs_app_settings_list below). No non-ephemeral listKeys action is
#     declared here, so the raw connection string never lands in state.
#
# After applying, run `terraform output acs_dns_records_for_operator` and add
# every returned record at your domain registrar before the Azure portal will
# mark the domain Verified.

locals {
  # Mirrors storage.tf's storage_prefix recomputation: T5 does not pass
  # `prefix` into the stamp module, so each stamp file derives it from
  # var.stamp_name independently.
  acs_prefix = "bccweb-${var.stamp_name}"
}

# ─── ACS Email Service ────────────────────────────────────────────────────────

resource "azapi_resource" "acs_email" {
  type      = "Microsoft.Communication/emailServices@2025-09-01"
  name      = "acs-email-${local.acs_prefix}"
  parent_id = azapi_resource.rg.id
  location  = "global"
  tags      = var.tags

  body = {
    properties = {
      dataLocation = "Europe"
    }
  }
}

# ─── Custom Domain (CustomerManaged) ─────────────────────────────────────────
#
# After apply, run: terraform output acs_dns_records_for_operator
# Add all returned DNS records at your domain registrar, then verify in the
# Azure portal or via: az communication email domain verify ...

resource "azapi_resource" "acs_email_domain" {
  type      = "Microsoft.Communication/emailServices/domains@2025-09-01"
  name      = var.acs_email_domain
  parent_id = azapi_resource.acs_email.id
  location  = "global"
  tags      = var.tags

  body = {
    properties = {
      domainManagement = "CustomerManaged"
    }
  }

  response_export_values = ["properties.verificationRecords"]
}

# ─── Verification-record decomposition ───────────────────────────────────────
#
# Azure ACS returns `properties.verificationRecords` as an object with keys
# Domain (ownership TXT), SPF (TXT), DKIM (CNAME), DKIM2 (CNAME) and DMARC
# (TXT). The operator must paste each record at their DNS registrar before the
# Azure portal will mark the domain Verified.
#
# DMARC policy guidance: the suggested DMARC TXT value returned by Azure is a
# starter record. For first deployment publish it with `p=none` so a
# misconfigured SPF/DKIM does NOT cause mail to be silently dropped. After at
# least one full week of clean delivery + monitored DMARC aggregate reports,
# tighten to `p=quarantine` and eventually `p=reject`.

locals {
  acs_verification_records = try(
    azapi_resource.acs_email_domain.output.properties.verificationRecords,
    {}
  )

  acs_dns_records_for_operator = {
    domain_ownership = try(local.acs_verification_records.Domain, null)
    spf              = try(local.acs_verification_records.SPF, null)
    dkim             = try(local.acs_verification_records.DKIM, null)
    dkim2            = try(local.acs_verification_records.DKIM2, null)
    dmarc            = try(local.acs_verification_records.DMARC, null)
  }

  acs_dmarc_recommended_value = "v=DMARC1; p=none; rua=mailto:${var.acs_sender_address}; ruf=mailto:${var.acs_sender_address}; pct=100; adkim=s; aspf=s"
}

# ─── ACS Base Resource ────────────────────────────────────────────────────────
#
# The email domain is linked via the `linkedDomains` property on the
# communicationServices body — no separate association resource needed.

resource "azapi_resource" "acs" {
  type      = "Microsoft.Communication/communicationServices@2025-09-01"
  name      = "acs-${local.acs_prefix}"
  parent_id = azapi_resource.rg.id
  location  = "global"
  tags      = var.tags

  body = {
    properties = {
      dataLocation  = "Europe"
      linkedDomains = [azapi_resource.acs_email_domain.id]
    }
  }
}

# ─── Function App settings — ACS + PureTrack ─────────────────────────────────
#
# The Function App's siteConfig.appSettings expects a list of {name, value}
# objects. T12 concatenates this list with the storage + auth settings.
#
# All secret values are sourced via Key Vault references rather than embedded
# plaintext. T10 declares `azapi_resource.kv` and writes the seven secrets
# (acs-connection-string, round-brief-emails, puretrack-*) into it; the
# Function App reads them at startup through its user-assigned managed
# identity (see T12). The Key Vault name is forwarded into the reference
# string via the `@Microsoft.KeyVault(VaultName=...;SecretName=...)` syntax
# that Azure App Service / Functions resolves natively.
#
# `local.acs_connection_string` is intentionally a Key Vault reference string
# (not a raw value): the underlying listKeys action lives as an `ephemeral
# azapi_resource_action.acs_keys` in keyvault.tf (T10), and ephemeral outputs
# cannot flow into a local. Routing the value through Key Vault is the
# secure-by-default path for app settings anyway.

locals {
  acs_connection_string = "@Microsoft.KeyVault(VaultName=${azapi_resource.kv.name};SecretName=acs-connection-string)"

  acs_app_settings_list = [
    { name = "ACS_CONNECTION_STRING", value = local.acs_connection_string },
    { name = "ACS_SENDER_ADDRESS", value = var.acs_sender_address },
    { name = "ROUND_BRIEF_EMAILS", value = "@Microsoft.KeyVault(VaultName=${azapi_resource.kv.name};SecretName=round-brief-emails)" },
    { name = "PURETRACK_API_KEY", value = "@Microsoft.KeyVault(VaultName=${azapi_resource.kv.name};SecretName=puretrack-api-key)" },
    { name = "PURETRACK_EMAIL", value = "@Microsoft.KeyVault(VaultName=${azapi_resource.kv.name};SecretName=puretrack-email)" },
    { name = "PURETRACK_PASSWORD", value = "@Microsoft.KeyVault(VaultName=${azapi_resource.kv.name};SecretName=puretrack-password)" },
  ]
}
