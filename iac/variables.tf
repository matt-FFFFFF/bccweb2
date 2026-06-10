# All variables flow into module "stamp" in main.tf. Per-env values live in env/<env>.tfvars.

variable "stamp_name" {
  description = "Environment/stamp name used as the suffix in resource names."
  type        = string
  nullable    = false
}

variable "location" {
  description = "Azure region for the deployment."
  type        = string
  default     = "uksouth"
}

variable "allowed_origins" {
  description = "Allowed CORS origins for the storage blob service."
  type        = list(string)
  default     = []
}

variable "ops_email" {
  description = "Alert recipient email address."
  type        = string
  nullable    = false
}

variable "slack_webhook_url" {
  description = "Optional Slack webhook URL for alerts."
  type        = string
  default     = ""
}

variable "production_hostname" {
  description = "Public hostname for DNS cutover."
  type        = string
  default     = ""
}

variable "dns_zone_name" {
  description = "Azure DNS zone name for managed cutover."
  type        = string
  default     = ""
}

variable "dns_zone_resource_group_name" {
  description = "Resource group containing the Azure DNS zone."
  type        = string
  default     = ""
}

variable "acs_email_domain" {
  description = "ACS email sending domain."
  type        = string
  nullable    = false
}

variable "acs_sender_address" {
  description = "ACS sender address."
  type        = string
  nullable    = false
}

variable "round_brief_emails" {
  description = "Comma-separated round brief recipients."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "puretrack_api_key" {
  description = "PureTrack API key."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "puretrack_email" {
  description = "PureTrack login email."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "puretrack_password" {
  description = "PureTrack login password."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "jwt_secret_version" {
  description = "Rotation trigger for the JWT secret copy in Key Vault."
  type        = string
  default     = "1"
}

variable "acs_secret_version" {
  description = "Rotation trigger for the ACS connection-string copy in Key Vault."
  type        = string
  default     = "1"
}

locals {
  prefix = "bccweb-${var.stamp_name}"
  tags = {
    project     = "bccweb"
    environment = var.stamp_name
    managed_by  = "terraform"
  }
}
