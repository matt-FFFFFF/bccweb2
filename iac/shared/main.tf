# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

data "azapi_client_config" "current" {}

locals {
  subscription_id               = data.azapi_client_config.current.subscription_id
  terraform_principal_object_id = data.azapi_client_config.current.object_id
  shared_rg_id                  = "/subscriptions/${local.subscription_id}/resourceGroups/${var.shared_rg_name}"

  tags = merge(var.tags, {
    project     = "bccweb"
    environment = "shared"
    managed_by  = "terraform"
  })
}
