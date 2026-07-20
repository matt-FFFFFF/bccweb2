# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

mock_provider "azapi" {
  alias           = "mock"
  override_during = plan

  mock_data "azapi_client_config" {
    defaults = {
      subscription_id = "00000000-0000-0000-0000-000000000000"
      tenant_id       = "00000000-0000-0000-0000-000000000001"
    }
  }

  mock_resource "azapi_resource" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-unit/providers/Microsoft.Mock/mockResources/mock"
      name = "mock"
      output = {
        properties = {
          clientId    = "00000000-0000-0000-0000-000000000002"
          principalId = "00000000-0000-0000-0000-000000000003"
        }
      }
    }
  }
}

mock_provider "github" {
  alias           = "mock"
  override_during = plan
}

mock_provider "local" {
  alias           = "mock"
  override_during = plan
}

variables {
  tfstate_storage_account_name = "stbccwebunittest"
  manage_github_secrets        = true
  github_environments          = ["staging", "shared"]

  terraform_umis = {
    staging = {
      stamp_rg   = "stamp-staging"
      github_env = "staging"
    }
    shared = {
      github_env = "shared"
    }
  }
}

run "published_github_variables_exclude_authored_stamp_name" {
  command = plan

  providers = {
    azapi  = azapi.mock
    github = github.mock
    local  = local.mock
  }

  assert {
    condition = alltrue([
      for key in keys(github_actions_environment_variable.rg_names) :
      !endswith(key, "/TF_VAR_stamp_name")
    ])
    error_message = "Bootstrap must not publish authored TF_VAR_stamp_name values."
  }

  assert {
    condition = alltrue([
      for retained_name in [
        "TF_VAR_STAMP_RG_NAME",
        "TF_VAR_shared_rg_name",
        "TF_VAR_env_umi_principal_ids",
        ] : contains([
          for variable in github_actions_environment_variable.rg_names :
          variable.variable_name
      ], retained_name)
    ])
    error_message = "Bootstrap must retain the generated stamp RG, shared RG, and environment UMI principal ID variables."
  }
}
