# ─── Azure Communication Services (ACS) — Email ───────────────────────────────
#
# Resources:
#   azapi_resource.acs              — ACS base resource (connection string)
#   azapi_resource.acs_email        — Email channel
#   azapi_resource.acs_email_domain — CustomerManaged domain (requires DNS)
#
# The email domain is linked to the ACS service via the `linkedDomains`
# property on the communicationServices resource (no separate association
# resource needed with azapi).
#
# Variables required (set in terraform.tfvars or CI secrets):
#   acs_email_domain    — Your verified sending domain, e.g. "mail.yourdomain.com"
#   acs_sender_address  — Full sender address, e.g. "noreply@mail.yourdomain.com"
#   round_brief_emails  — Comma-separated brief recipient addresses
#   puretrack_api_key   — PureTrack API key
#   puretrack_email     — PureTrack login email
#   puretrack_password  — PureTrack login password
#
# After applying, check outputs for DNS records to add at your registrar.

# ─── Variables ────────────────────────────────────────────────────────────────

variable "acs_email_domain" {
  description = "Custom sending domain for ACS Email (e.g. mail.yourdomain.com)"
  type        = string
}

variable "acs_sender_address" {
  description = "Full sender email address (e.g. noreply@mail.yourdomain.com)"
  type        = string
}

variable "round_brief_emails" {
  description = "Comma-separated list of email addresses to receive round briefs"
  type        = string
  sensitive   = true
}

variable "puretrack_api_key" {
  description = "PureTrack API key for the BCC account"
  type        = string
  sensitive   = true
}

variable "puretrack_email" {
  description = "PureTrack login email for the BCC account"
  type        = string
  sensitive   = true
}

variable "puretrack_password" {
  description = "PureTrack login password for the BCC account"
  type        = string
  sensitive   = true
}

# ─── ACS Email Service ────────────────────────────────────────────────────────

resource "azapi_resource" "acs_email" {
  type      = "Microsoft.Communication/emailServices@2023-04-01"
  name      = "acs-email-${local.prefix}"
  parent_id = azapi_resource.resource_group.id
  location  = "global"
  tags      = local.tags

  body = {
    properties = {
      dataLocation = "Europe"
    }
  }
}

# ─── Custom Domain (CustomerManaged) ─────────────────────────────────────────
#
# After apply, run: terraform output acs_dns_records
# Add all returned DNS records at your domain registrar, then verify in the
# Azure portal or via: az communication email domain verify ...

resource "azapi_resource" "acs_email_domain" {
  type      = "Microsoft.Communication/emailServices/domains@2023-04-01"
  name      = var.acs_email_domain
  parent_id = azapi_resource.acs_email.id
  location  = "global"
  tags      = local.tags

  body = {
    properties = {
      domainManagement = "CustomerManaged"
    }
  }

  response_export_values = ["properties.verificationRecords"]
}

# ─── ACS Base Resource ────────────────────────────────────────────────────────
#
# The email domain is linked via the `linkedDomains` property, replacing
# the separate azurerm_communication_service_email_domain_association resource.

resource "azapi_resource" "acs" {
  type      = "Microsoft.Communication/communicationServices@2023-04-01"
  name      = "acs-${local.prefix}"
  parent_id = azapi_resource.resource_group.id
  location  = "global"
  tags      = local.tags

  body = {
    properties = {
      dataLocation  = "Europe"
      linkedDomains = [azapi_resource.acs_email_domain.id]
    }
  }
}

# ─── ACS Connection String ────────────────────────────────────────────────────

resource "azapi_resource_action" "acs_keys" {
  type        = "Microsoft.Communication/communicationServices@2023-04-01"
  resource_id = azapi_resource.acs.id
  action      = "listKeys"
  method      = "POST"

  response_export_values = ["primaryConnectionString"]
}

# ─── Function App settings — ACS + PureTrack ─────────────────────────────────
#
# The Function App's siteConfig.appSettings expects a list of {name, value}
# objects. We build it here and concat it in functions.tf.

locals {
  acs_connection_string = azapi_resource_action.acs_keys.output.primaryConnectionString

  acs_app_settings_list = [
    { name = "ACS_CONNECTION_STRING", value = local.acs_connection_string },
    { name = "ACS_SENDER_ADDRESS", value = var.acs_sender_address },
    { name = "ROUND_BRIEF_EMAILS", value = var.round_brief_emails },
    { name = "PURETRACK_API_KEY", value = var.puretrack_api_key },
    { name = "PURETRACK_EMAIL", value = var.puretrack_email },
    { name = "PURETRACK_PASSWORD", value = var.puretrack_password },
  ]
}
