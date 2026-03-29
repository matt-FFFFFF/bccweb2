# ─── Azure Communication Services (ACS) — Email ───────────────────────────────
#
# Resources:
#   azurerm_communication_service         — ACS base resource (connection string)
#   azurerm_email_communication_service   — Email channel
#   azurerm_email_communication_service_domain — CustomerManaged domain (requires DNS)
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

# ─── ACS Base Resource ────────────────────────────────────────────────────────

resource "azurerm_communication_service" "main" {
  name                = "acs-${local.prefix}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = "Europe"
  tags                = local.tags
}

# ─── ACS Email Service ────────────────────────────────────────────────────────

resource "azurerm_email_communication_service" "main" {
  name                = "acs-email-${local.prefix}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = "Europe"
  tags                = local.tags
}

# ─── Custom Domain (CustomerManaged) ─────────────────────────────────────────
#
# After apply, run: terraform output acs_dns_records
# Add all returned DNS records at your domain registrar, then verify in the
# Azure portal or via: az communication email domain verify ...

resource "azurerm_email_communication_service_domain" "main" {
  name              = var.acs_email_domain
  email_service_id  = azurerm_email_communication_service.main.id
  domain_management = "CustomerManaged"
  tags              = local.tags
}

# ─── Link Email domain to ACS base resource ───────────────────────────────────

resource "azurerm_communication_service_email_domain_association" "main" {
  communication_service_id = azurerm_communication_service.main.id
  email_service_domain_id  = azurerm_email_communication_service_domain.main.id
}

# ─── Function App settings — ACS + PureTrack ─────────────────────────────────
#
# Merge into the existing function app. Terraform merges app_settings blocks;
# we use a separate azurerm_linux_function_app_slot-style approach by
# adding these settings into the main function app via a locals merge.
# NOTE: Because azurerm_linux_function_app only allows one app_settings block,
# we extend it here by overriding the resource in functions.tf via local values.
# The actual injection is done in functions.tf using local.all_app_settings.

locals {
  acs_app_settings = {
    ACS_CONNECTION_STRING = azurerm_communication_service.main.primary_connection_string
    ACS_SENDER_ADDRESS    = var.acs_sender_address
    ROUND_BRIEF_EMAILS    = var.round_brief_emails
    PURETRACK_API_KEY     = var.puretrack_api_key
    PURETRACK_EMAIL       = var.puretrack_email
    PURETRACK_PASSWORD    = var.puretrack_password
  }
}
