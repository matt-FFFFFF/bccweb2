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
      name = "mock"
      output = {
        id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-shared/providers/Microsoft.Mock/mockResources/mock"
        name = "mock"
        properties = {
          defaultHostname = "shared.example.test"
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
  shared_rg_name     = "rg-bccweb-shared"
  acs_email_domain   = "mail.shared.example.test"
  acs_sender_address = "no-reply@mail.shared.example.test"

  env_umi_principal_ids = {
    staging = "10000000-0000-0000-0000-000000000001"
    prod    = "20000000-0000-0000-0000-000000000002"
  }

  production_hostname          = "www.shared.example.test"
  dns_zone_name                = "shared.example.test"
  dns_zone_resource_group_name = "rg-bccweb-dns"
}

run "shared_plans" {
  command = plan

  providers = {
    azapi = azapi.mock
  }

  assert {
    condition = (
      azapi_resource.law.name == "log-bccweb-shared" &&
      azapi_resource.law.type == "Microsoft.OperationalInsights/workspaces@2025-07-01" &&
      azapi_resource.law.body.properties.sku.name == "PerGB2018"
    )
    error_message = "The shared Log Analytics workspace must keep its frozen name, API type, and SKU."
  }

  assert {
    condition = (
      toset(keys(azapi_resource.ai)) == toset(["staging", "prod"]) &&
      azapi_resource.ai["staging"].name == "appi-bccweb-staging" &&
      azapi_resource.ai["prod"].name == "appi-bccweb-prod" &&
      alltrue([for resource in azapi_resource.ai : resource.type == "Microsoft.Insights/components@2020-02-02"])
    )
    error_message = "Application Insights must contain exactly the frozen staging and prod resources with their expected names and API type."
  }

  assert {
    condition = (
      azapi_resource.acs_email.name == "acs-email-bccweb-shared" &&
      azapi_resource.acs_email.type == "Microsoft.Communication/emailServices@2025-09-01" &&
      azapi_resource.acs_email_domain.name == var.acs_email_domain &&
      azapi_resource.acs_email_domain.type == "Microsoft.Communication/emailServices/domains@2025-09-01" &&
      azapi_resource.acs_sender_username.name == "no-reply" &&
      azapi_resource.acs_sender_username.type == "Microsoft.Communication/emailServices/domains/senderUsernames@2025-09-01" &&
      azapi_resource.acs_sender_username.parent_id == azapi_resource.acs_email_domain.id &&
      azapi_resource.acs.name == "acs-bccweb-shared" &&
      azapi_resource.acs.type == "Microsoft.Communication/communicationServices@2025-09-01" &&
      length(azapi_resource.acs.body.properties.linkedDomains) == 0
    )
    error_message = "The shared ACS resources must keep their frozen names and API types, without linking an unverified email domain."
  }

  assert {
    condition = (
      azapi_resource.swa.name == "swa-bccweb-shared" &&
      azapi_resource.swa.type == "Microsoft.Web/staticSites@2025-03-01" &&
      azapi_resource.swa.location == "westeurope" &&
      azapi_resource.swa.body.sku.name == "Standard" &&
      azapi_resource.swa.body.sku.tier == "Standard"
    )
    error_message = "The shared Static Web App must keep its frozen name, supported West Europe location, API type, and Standard SKU."
  }

  assert {
    condition = (
      length(azapi_resource.production_cname) == 1 &&
      azapi_resource.production_cname[0].type == "Microsoft.Network/dnsZones/CNAME@2018-05-01" &&
      azapi_resource.production_cname[0].name == "www" &&
      length(azapi_resource.swa_custom_domain) == 1 &&
      azapi_resource.swa_custom_domain[0].type == "Microsoft.Web/staticSites/customDomains@2025-03-01" &&
      azapi_resource.swa_custom_domain[0].body.properties.validationMethod == "cname-delegation"
    )
    error_message = "Supplying production DNS inputs must plan one CNAME and one cname-delegation Static Web App custom domain."
  }

  assert {
    condition = (
      toset(keys(output.app_insights_ids)) == toset(["staging", "prod"]) &&
      output.app_insights_ids["staging"] == azapi_resource.ai["staging"].id &&
      output.app_insights_ids["prod"] == azapi_resource.ai["prod"].id &&
      output.log_analytics_workspace_id == azapi_resource.law.id
    )
    error_message = "The monitoring outputs must expose the two environment IDs and shared workspace ID."
  }

  assert {
    condition = (
      output.acs_id == azapi_resource.acs.id &&
      output.acs_email_domain_id == azapi_resource.acs_email_domain.id &&
      output.acs_sender_address == var.acs_sender_address &&
      output.acs_dns_records_for_operator.domain_ownership.value == "test-domain" &&
      output.acs_dns_records_for_operator.spf.value != "" &&
      output.acs_dns_records_for_operator.dkim.value != "" &&
      output.acs_dns_records_for_operator.dkim2.value != "" &&
      output.acs_dns_records_for_operator.dmarc.value != ""
    )
    error_message = "The ACS outputs must expose only the shared IDs, sender address, and complete operator DNS record shape."
  }

  assert {
    condition = (
      output.swa_name == "swa-bccweb-shared" &&
      output.swa_default_hostname == "shared.example.test" &&
      output.swa_id == azapi_resource.swa.id
    )
    error_message = "The Static Web App outputs must expose its frozen name, default hostname, and resource ID."
  }
}

run "verified_acs_email_domain_can_be_linked" {
  command = plan

  providers = {
    azapi = azapi.mock
  }

  variables {
    link_acs_email_domain = true
  }

  assert {
    condition = (
      length(azapi_resource.acs.body.properties.linkedDomains) == 1 &&
      azapi_resource.acs.body.properties.linkedDomains[0] == azapi_resource.acs_email_domain.id
    )
    error_message = "Explicitly enabling a verified ACS email domain must link exactly that domain."
  }
}

run "dns_zone_rg_falls_back_to_zone_name" {
  command = plan

  providers = {
    azapi = azapi.mock
  }

  variables {
    dns_zone_resource_group_name = ""
  }

  assert {
    condition = (
      strcontains(azapi_resource.production_cname[0].parent_id, "/resourceGroups/${var.dns_zone_name}/") &&
      !strcontains(azapi_resource.production_cname[0].parent_id, "/resourceGroups//")
    )
    error_message = "An empty DNS resource-group input must fall back to the DNS zone name without producing an empty resource-group segment."
  }
}

run "production_hostname_must_be_zone_subdomain" {
  command = plan

  providers = {
    azapi = azapi.mock
  }

  variables {
    production_hostname = "www.unrelated.example.test"
  }

  expect_failures = [var.production_hostname]
}

run "acs_sender_address_domain_must_match_email_domain" {
  command = plan

  providers = {
    azapi = azapi.mock
  }

  variables {
    acs_sender_address = "no-reply@unrelated.example.test"
  }

  expect_failures = [var.acs_sender_address]
}
