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
}

run "env_umi_principal_ids_values_must_not_be_blank" {
  command = plan

  providers = {
    azapi = azapi.mock
  }

  variables {
    env_umi_principal_ids = {
      staging = "   "
      prod    = "20000000-0000-0000-0000-000000000002"
    }
  }

  expect_failures = [var.env_umi_principal_ids]
}

run "shared_rg_name_must_not_be_blank" {
  command = plan

  providers = {
    azapi = azapi.mock
  }

  variables {
    shared_rg_name = "   "
  }

  expect_failures = [var.shared_rg_name]
}
