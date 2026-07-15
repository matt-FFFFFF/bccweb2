# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

variable "stamp_name" {
  description = "Environment/stamp name used as the suffix in resource names."
  type        = string
  nullable    = false
}

variable "location" {
  description = "Azure region for the platform resources."
  type        = string
  default     = "uksouth"
}

variable "acs_email_domain" {
  description = "ACS email sending domain for this environment."
  type        = string
  nullable    = false
}

variable "platform_rg_name" {
  description = "Name of the pre-created platform resource group."
  type        = string
  nullable    = false
}

variable "tags" {
  description = "Tags applied to the platform resources."
  type        = map(string)
  default     = {}
}

variable "subscription_id" {
  description = "Azure subscription containing the platform resource group."
  type        = string
  nullable    = false
}
