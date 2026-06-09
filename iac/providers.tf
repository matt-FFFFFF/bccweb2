terraform {
  required_version = ">= 1.10"

  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.8"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }

  # Uncomment and configure once a backend storage account exists:
  # backend "azurerm" {
  #   resource_group_name  = "rg-bccweb-tfstate"
  #   storage_account_name = "stbccwebtfstate"
  #   container_name       = "tfstate"
  #   key                  = "bccweb2.tfstate"
  # }
}

provider "azapi" {}

provider "azurerm" {
  features {}
}
