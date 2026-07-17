# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

mock_provider "azapi" {
  alias           = "mock"
  override_during = plan

  mock_data "azapi_client_config" {
    defaults = {
      subscription_id = "00000000-0000-0000-0000-000000000000"
      object_id       = "00000000-0000-0000-0000-000000000001"
      tenant_id       = "00000000-0000-0000-0000-000000000002"
    }
  }

  mock_resource "azapi_resource" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-shared/providers/Microsoft.Mock/mockResources/mock"
      name = "00000000-0000-0000-0000-000000000003"
    }
  }
}

override_resource {
  target          = azapi_resource.ai["staging"]
  override_during = plan
  values = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-shared/providers/Microsoft.Insights/components/appi-bccweb-staging"
  }
}

override_resource {
  target          = azapi_resource.ai["prod"]
  override_during = plan
  values = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-shared/providers/Microsoft.Insights/components/appi-bccweb-prod"
  }
}

override_resource {
  target          = azapi_resource.acs
  override_during = plan
  values = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-shared/providers/Microsoft.Communication/communicationServices/acs-bccweb-shared"
  }
}

override_resource {
  target          = azapi_resource.swa
  override_during = plan
  values = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-shared/providers/Microsoft.Web/staticSites/swa-bccweb-shared"
    output = {
      properties = {
        defaultHostname = "shared.example.test"
      }
    }
  }
}

variables {
  shared_rg_name     = "rg-bccweb-shared"
  acs_email_domain   = "mail.shared.example.test"
  acs_sender_address = "no-reply@mail.shared.example.test"

  env_umi_principal_ids = {
    staging = "10000000-0000-0000-0000-000000000001"
    prod    = "20000000-0000-0000-0000-000000000002"
  }
}

run "rbac_plans" {
  command = plan

  providers = {
    azapi = azapi.mock
  }

  assert {
    condition = (
      length(azapi_resource.env_ai_monitoring_reader) +
      length(azapi_resource.env_acs_contributor) +
      length(azapi_resource.env_swa_contributor)
    ) == 6
    error_message = "Exactly six shared-resource role assignments must be planned for the two application environments."
  }

  assert {
    condition = (
      toset(keys(azapi_resource.env_ai_monitoring_reader)) == toset(["staging", "prod"]) &&
      toset(keys(azapi_resource.env_acs_contributor)) == toset(["staging", "prod"]) &&
      toset(keys(azapi_resource.env_swa_contributor)) == toset(["staging", "prod"])
    )
    error_message = "Each RBAC family must contain exactly one staging and one prod assignment."
  }

  assert {
    condition = alltrue([
      for env, assignment in azapi_resource.env_ai_monitoring_reader :
      assignment.type == "Microsoft.Authorization/roleAssignments@2022-04-01" &&
      assignment.parent_id == azapi_resource.ai[env].id &&
      azapi_resource.ai[env].type == "Microsoft.Insights/components@2020-02-02" &&
      assignment.parent_id != local.shared_rg_id &&
      assignment.body.properties.roleDefinitionId == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/43d0d8ad-25c7-4714-9337-8ba259a9fe05" &&
      assignment.body.properties.principalId == var.env_umi_principal_ids[env] &&
      assignment.body.properties.principalType == "ServicePrincipal" &&
      can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", assignment.name))
    ])
    error_message = "Every environment UMI must receive Monitoring Reader on its own Application Insights leaf resource with a stable GUID assignment name."
  }

  assert {
    condition = alltrue([
      for env, assignment in azapi_resource.env_acs_contributor :
      assignment.type == "Microsoft.Authorization/roleAssignments@2022-04-01" &&
      assignment.parent_id == azapi_resource.acs.id &&
      azapi_resource.acs.type == "Microsoft.Communication/communicationServices@2025-09-01" &&
      assignment.parent_id != local.shared_rg_id &&
      assignment.body.properties.roleDefinitionId == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c" &&
      assignment.body.properties.principalId == var.env_umi_principal_ids[env] &&
      assignment.body.properties.principalType == "ServicePrincipal" &&
      can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", assignment.name))
    ])
    error_message = "Every environment UMI must receive Contributor only on the shared ACS leaf resource with a stable GUID assignment name."
  }

  assert {
    condition = alltrue([
      for env, assignment in azapi_resource.env_swa_contributor :
      assignment.type == "Microsoft.Authorization/roleAssignments@2022-04-01" &&
      assignment.parent_id == azapi_resource.swa.id &&
      azapi_resource.swa.type == "Microsoft.Web/staticSites@2025-03-01" &&
      assignment.parent_id != local.shared_rg_id &&
      assignment.body.properties.roleDefinitionId == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c" &&
      assignment.body.properties.principalId == var.env_umi_principal_ids[env] &&
      assignment.body.properties.principalType == "ServicePrincipal" &&
      can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", assignment.name))
    ])
    error_message = "Every environment UMI must receive Contributor only on the shared Static Web App leaf resource with a stable GUID assignment name."
  }

  assert {
    condition = alltrue(flatten([
      for assignments in [
        azapi_resource.env_ai_monitoring_reader,
        azapi_resource.env_acs_contributor,
        azapi_resource.env_swa_contributor,
      ] : [
        for assignment in assignments :
        !strcontains(lower(assignment.parent_id), "/dnszones/")
      ]
    ]))
    error_message = "Shared RBAC must not contain a DNS-zone scope; the family-specific assertions allow only Monitoring Reader or Contributor."
  }
}
