# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Inputs for the per-env common (observability + email domain) stack. Per-env
# values live in ../env/common-<env>.tfvars (committed — nothing here is
# sensitive).

variable "stamp_name" {
  description = "Environment/stamp name used as the suffix in resource names (e.g. dev, prod)."
  type        = string
  nullable    = false
}

variable "acs_email_domain" {
  description = "ACS email sending domain for this environment (e.g. mail.example.com). Per-env so domain reputation and DNS verification stay isolated; the verified domain lives here, not in the stamp, so service-stack rebuilds never force re-verification."
  type        = string
  nullable    = false
}

variable "location" {
  description = "Azure region for the deployment."
  type        = string
  default     = "uksouth"
}

variable "tags" {
  description = "Extra tags merged into the standard project tags."
  type        = map(string)
  default     = {}
}
