# Inputs for the bccweb2 tfstate bootstrap.
#
# Only `tfstate_storage_account_name` has no default — Azure storage account
# names must be globally unique, so the operator must supply one (lowercase,
# 3–24 chars, letters and digits only).

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

variable "tfstate_container_name" {
  type        = string
  description = "Name of the blob container that holds tfstate files (one blob per environment, e.g. prod.tfstate)."
  default     = "tfstate"
}

# ─── Terraform UMI + GitHub OIDC federation ──────────────────────────────────
#
# The bootstrap provisions a single user-assigned managed identity (UMI) that
# CI uses to run Terraform. One federated identity credential is created per
# GitHub environment name in `github_environments`, scoped to
# `repo:<github_repo>:environment:<env>`. Adding a new env is a one-line
# variable bump + re-apply.

variable "github_repo" {
  type        = string
  description = "owner/repo for GitHub OIDC federated credentials (subject claim becomes repo:<owner/repo>:environment:<env>)."
  default     = "matt-FFFFFF/bccweb2"
}

variable "github_environments" {
  type        = list(string)
  description = "GitHub environment names that need OIDC federation to the Terraform UMI. One federated credential is created per entry."
  default     = ["prod"]

  validation {
    condition     = alltrue([for e in var.github_environments : can(regex("^[a-z0-9-]+$", e))])
    error_message = "Each GitHub environment name must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens)."
  }
}

variable "terraform_umi_name" {
  type        = string
  description = "Name of the user-assigned managed identity that Terraform uses (created in the bootstrap RG)."
  default     = "id-bccweb-terraform"
}
