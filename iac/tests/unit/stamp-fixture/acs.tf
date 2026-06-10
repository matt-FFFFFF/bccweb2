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
#     keyvault.tf. It is called against azapi_resource.acs.id and used
#     ONLY to write the ACS primary connection string into Key Vault. The
#     Function App reads it back via a Key Vault reference (see
#     iac/modules/stamp/functions.tf). No non-ephemeral listKeys action is
#     declared here, so the raw connection string never lands in state.
#
# After applying, run `terraform output acs_dns_records_for_operator` and add
# every returned record at your domain registrar before the Azure portal will
# mark the domain Verified.

locals {
  # Mirrors storage.tf's storage_prefix recomputation: the root module does
  # not pass `prefix` into the stamp module, so each stamp file derives it
  # from var.stamp_name independently.
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
