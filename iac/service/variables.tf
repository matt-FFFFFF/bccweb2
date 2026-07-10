# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# All variables flow into module "stamp" in main.tf. Per-env values live in ../env/<env>.tfvars.

variable "stamp_name" {
  description = "Environment/stamp name used as the suffix in resource names."
  type        = string
  nullable    = false
}

variable "tfstate_rg_name" {
  description = "Resource group holding the tfstate storage account (bootstrap output resource_group_name)."
  type        = string
  default     = "rg-bccweb-tfstate"
}

variable "tfstate_sa_name" {
  description = "Storage account hosting the tfstate blobs (bootstrap output storage_account_name). Used to read the common stack's remote state."
  type        = string
  nullable    = false
}

variable "terraform_principal_type" {
  description = "Principal type for the identity running Terraform (ServicePrincipal for CI OIDC UMIs; User for local az login applies)."
  type        = string
  default     = "ServicePrincipal"

  validation {
    condition     = contains(["User", "ServicePrincipal"], var.terraform_principal_type)
    error_message = "terraform_principal_type must be either \"User\" or \"ServicePrincipal\"."
  }
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

variable "blob_schema_mode" {
  description = "Blob schema mode for public/private JSON writes."
  type        = string
  default     = "observe"

  validation {
    condition     = contains(["observe", "enforce"], var.blob_schema_mode)
    error_message = "blob_schema_mode must be either \"observe\" or \"enforce\"."
  }
}

locals {
  prefix = "bccweb-${var.stamp_name}"
  tags = {
    project     = "bccweb"
    environment = var.stamp_name
    managed_by  = "terraform"
  }
}
