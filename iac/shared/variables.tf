# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

variable "environments" {
  description = "Stable application environments consuming shared infrastructure."
  type        = list(string)
  default     = ["staging", "prod"]
  nullable    = false
}

variable "location" {
  description = "Azure region for shared regional resources."
  type        = string
  default     = "uksouth"
}

variable "shared_rg_name" {
  description = "Name of the pre-created shared resource group owned by iac/bootstrap."
  type        = string
  nullable    = false
}

variable "acs_email_domain" {
  description = "Customer-managed sending domain for the shared ACS email service."
  type        = string
  nullable    = false
}

variable "acs_sender_address" {
  description = "Full sender address on the shared ACS email domain."
  type        = string
  nullable    = false

  validation {
    condition = (
      length(split("@", var.acs_sender_address)) == 2 &&
      trimspace(split("@", var.acs_sender_address)[0]) != "" &&
      split("@", var.acs_sender_address)[1] == var.acs_email_domain
    )
    error_message = "acs_sender_address must be exactly one <local-part>@<domain> whose domain equals acs_email_domain."
  }
}

variable "production_hostname" {
  description = "Public production hostname for the shared Static Web App."
  type        = string
  default     = ""

  validation {
    condition     = var.production_hostname == "" || var.dns_zone_name == "" || (endswith(var.production_hostname, ".${var.dns_zone_name}") && var.production_hostname != var.dns_zone_name)
    error_message = "production_hostname must be a non-apex subdomain of dns_zone_name (end with `.<dns_zone_name>`)."
  }
}

variable "dns_zone_name" {
  description = "Azure DNS zone name used for the production hostname."
  type        = string
  default     = ""
}

variable "dns_zone_resource_group_name" {
  description = "Resource group containing the Azure DNS zone."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Additional tags merged with the canonical shared-resource tags."
  type        = map(string)
  default     = {}
}

variable "env_umi_principal_ids" {
  description = "Application environment names mapped to their Terraform UMI principal IDs for leaf-scoped shared-resource RBAC."
  type        = map(string)
  nullable    = false

  validation {
    condition     = alltrue([for e in var.environments : contains(keys(var.env_umi_principal_ids), e)])
    error_message = "env_umi_principal_ids must contain an entry for every environment in environments."
  }
}

variable "terraform_principal_type" {
  description = "Principal type for the identity running Terraform (ServicePrincipal for CI OIDC UMIs; User for local az login plans)."
  type        = string
  default     = "ServicePrincipal"

  validation {
    condition     = contains(["User", "ServicePrincipal"], var.terraform_principal_type)
    error_message = "terraform_principal_type must be either \"User\" or \"ServicePrincipal\"."
  }
}
