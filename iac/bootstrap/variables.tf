# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Inputs for the bccweb2 tfstate bootstrap.
#
# `tfstate_storage_account_name` has no default — Azure storage account
# names must be globally unique, so the operator must supply one (lowercase,
# 3–24 chars, letters and digits only). `terraform_umis` has no default —
# the operator supplies the canonical per-env map via terraform.tfvars
# (see terraform.tfvars.example).

variable "location" {
  type        = string
  description = "Azure region for the bootstrap resource group and tfstate storage account."
  default     = "uksouth"
}

variable "bootstrap_rg_name" {
  type        = string
  description = "Name of the bootstrap resource group that holds the tfstate storage account."
  default     = "rg-bccweb-tfstate"
}

variable "tfstate_storage_account_name" {
  type        = string
  description = "Globally-unique storage account name (3–24 chars, lowercase letters and digits) that will host the tfstate blob container. Operator must supply."
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.tfstate_storage_account_name))
    error_message = "tfstate_storage_account_name must be 3–24 chars, lowercase letters and digits only."
  }
}

variable "tfstate_container_prefix" {
  type        = string
  description = "Name of the blob container that holds tfstate files (one blob per environment, e.g. prod.tfstate)."
  default     = "tfstate"
}

# ─── Terraform UMIs + GitHub OIDC federation ─────────────────────────────────
#
# One UMI per environment; each UMI gets Owner on its env's pre-created
# platform RG and stamp RG (never subscription scope). Each UMI carries one
# federated identity credential scoped to
# `repo:<github_repo>:environment:<github_env>`. Adding a new env is a new
# `terraform_umis` map entry (plus the matching `github_environments` entry)
# + re-apply.

variable "github_repo" {
  type        = string
  description = "owner/repo for GitHub OIDC federated credentials (subject claim becomes repo:<owner/repo>:environment:<env>)."
  default     = "matt-FFFFFF/bccweb2"
}

variable "github_environments" {
  type        = set(string)
  description = "GitHub environment names that receive the per-env Azure OIDC secrets. Every `terraform_umis` entry's `github_env` must appear in this list."
  default     = ["dev", "prod"]

  validation {
    condition     = alltrue([for e in var.github_environments : can(regex("^[a-z0-9-]+$", e))])
    error_message = "Each GitHub environment name must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens)."
  }
}

variable "terraform_umis" {
  type = map(object({
    platform_rg = string
    stamp_rg    = string
    github_env  = string
  }))
  description = "Per-environment Terraform UMIs, keyed by env name (e.g. dev, prod). Each entry names the two pre-created RGs the UMI owns (platform + stamp) and the GitHub environment whose OIDC subject the UMI trusts. The UMI is named id-bccweb-terraform-<key>. No default — supply via terraform.tfvars (see terraform.tfvars.example)."
  nullable    = false

  validation {
    condition     = alltrue([for k, v in var.terraform_umis : can(regex("^[a-z0-9-]+$", k))])
    error_message = "Each terraform_umis key must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens)."
  }

  validation {
    condition     = alltrue([for k, v in var.terraform_umis : contains(var.github_environments, v.github_env)])
    error_message = "Each terraform_umis entry's github_env must be listed in github_environments."
  }
}

variable "manage_github_secrets" {
  type        = bool
  description = "Set to false to provision only the UMI + fed creds and skip GitHub repo secret creation (e.g. when operating without GITHUB_TOKEN). When true (default), Terraform creates one GitHub environment per `github_environments` entry and pushes AZURE_CLIENT_ID/AZURE_TENANT_ID/AZURE_SUBSCRIPTION_ID as environment-scoped Actions secrets."
  default     = true
}
