terraform {
  required_version = "~> 1.11"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
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

provider "azurerm" {
  features {}
}
