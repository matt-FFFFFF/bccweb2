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
