# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
mock_provider "azapi" {
  alias           = "mock"
  override_during = plan

  mock_resource "azapi_resource" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-platform-unit/providers/Microsoft.Mock/mockResources/mock"
      name = "mock"
      output = {
        id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-platform-unit/providers/Microsoft.Mock/mockResources/mock"
        name = "mock"
        properties = {
          ConnectionString = "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test/"
          verificationRecords = {
            Domain = { type = "TXT", name = "@", value = "test-domain" }
            SPF    = { type = "TXT", name = "@", value = "v=spf1 include:spf.protection.outlook.com -all" }
            DKIM   = { type = "CNAME", name = "selector1", value = "selector1.example.test" }
            DKIM2  = { type = "CNAME", name = "selector2", value = "selector2.example.test" }
            DMARC  = { type = "TXT", name = "_dmarc", value = "v=DMARC1; p=none" }
          }
        }
      }
    }
  }
}

variables {
  stamp_name       = "unit"
  location         = "uksouth"
  acs_email_domain = "mail.unit.example.test"
  platform_rg_name = "rg-bccweb-platform-unit"
  subscription_id  = "00000000-0000-0000-0000-000000000000"
  tags             = {}
}

run "platform_plans" {
  command = plan

  providers = {
    azapi = azapi.mock
  }

  module {
    source = "./modules/platform"
  }

  assert {
    condition = (
      azapi_resource.law.name == "log-bccweb-unit" &&
      azapi_resource.law.type == "Microsoft.OperationalInsights/workspaces@2025-07-01" &&
      azapi_resource.law.body.properties.retentionInDays == 30 &&
      azapi_resource.law.body.properties.features.enableLogAccessUsingOnlyResourcePermissions
    )
    error_message = "The Log Analytics workspace should use the expected name, API type, retention, and resource-only access setting."
  }

  assert {
    condition     = endswith(azapi_resource.law.parent_id, "/resourceGroups/rg-bccweb-platform-unit")
    error_message = "The Log Analytics workspace parent must use the explicit platform_rg_name input."
  }

  assert {
    condition = (
      azapi_resource.ai.name == "appi-bccweb-unit" &&
      azapi_resource.ai.type == "Microsoft.Insights/components@2020-02-02" &&
      azapi_resource.ai.body.properties.WorkspaceResourceId == azapi_resource.law.id &&
      azapi_resource.ai.body.properties.SamplingPercentage == 25
    )
    error_message = "Application Insights should use the expected name and API type and depend on the planned workspace with 25 percent sampling."
  }

  assert {
    condition = (
      azapi_resource.acs_email.name == "acs-email-bccweb-unit" &&
      azapi_resource.acs_email.type == "Microsoft.Communication/emailServices@2025-09-01" &&
      azapi_resource.acs_email.parent_id == azapi_resource.law.parent_id &&
      azapi_resource.acs_email.body.properties.dataLocation == "Europe"
    )
    error_message = "The ACS email service should use the expected name and API type in the platform resource group and Europe data location."
  }

  assert {
    condition = (
      azapi_resource.acs_email_domain.name == var.acs_email_domain &&
      azapi_resource.acs_email_domain.type == "Microsoft.Communication/emailServices/domains@2025-09-01" &&
      azapi_resource.acs_email_domain.body.properties.domainManagement == "CustomerManaged"
    )
    error_message = "The ACS email domain should use the explicit domain, expected API type, and customer-managed mode."
  }

  assert {
    condition     = azapi_resource.acs_email_domain.parent_id == azapi_resource.acs_email.id
    error_message = "The ACS email domain should be parented by the ACS email service."
  }

  assert {
    condition = (
      output.acs_email_domain_id == azapi_resource.acs_email_domain.id &&
      output.app_insights_id == azapi_resource.ai.id &&
      output.log_analytics_workspace_id == azapi_resource.law.id &&
      output.platform_rg_name == var.platform_rg_name
    )
    error_message = "The platform module should expose the planned ACS domain, Application Insights, workspace, and resource-group values."
  }

  assert {
    condition = (
      output.acs_email_domain_verification_records.Domain.value == "test-domain" &&
      output.acs_dns_records_for_operator.domain_ownership == output.acs_email_domain_verification_records.Domain &&
      output.acs_dns_records_for_operator.spf == output.acs_email_domain_verification_records.SPF &&
      output.acs_dns_records_for_operator.dkim == output.acs_email_domain_verification_records.DKIM &&
      output.acs_dns_records_for_operator.dkim2 == output.acs_email_domain_verification_records.DKIM2 &&
      output.acs_dns_records_for_operator.dmarc == output.acs_email_domain_verification_records.DMARC
    )
    error_message = "The operator DNS output should map every lowercase key to the corresponding raw Azure verification record."
  }
}
