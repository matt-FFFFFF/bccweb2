# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

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

provider "azapi" {}
