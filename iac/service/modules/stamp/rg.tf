# The stamp RG is pre-created by iac/bootstrap (which grants the per-env
# Terraform UMI RG-scoped Owner on it). The module never reads or manages the
# RG — its ID is fully determined by subscription + name, so child resources
# just interpolate it.
# data.azapi_client_config.current is declared in keyvault.tf (module-local).

locals {
  stamp_rg_id = "/subscriptions/${data.azapi_client_config.current.subscription_id}/resourceGroups/${var.stamp_rg_name}"
}
