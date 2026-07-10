# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
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
