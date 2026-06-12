# Per-env common (observability) stack. AzAPI-only. Backend config via -backend-config=../env/common-<env>.backend.hcl.

terraform {
  required_version = "~> 1.11"

  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.10"
    }
  }

  backend "azurerm" {}
}
