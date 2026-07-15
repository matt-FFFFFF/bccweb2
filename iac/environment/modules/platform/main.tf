# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

locals {
  platform_rg_id = "/subscriptions/${var.subscription_id}/resourceGroups/${var.platform_rg_name}"

  tags = merge(var.tags, {
    project     = "bccweb"
    environment = var.stamp_name
    managed_by  = "terraform"
  })
}

resource "azapi_resource" "law" {
  type      = "Microsoft.OperationalInsights/workspaces@2025-07-01"
  parent_id = local.platform_rg_id
  name      = "log-bccweb-${var.stamp_name}"
  location  = var.location

  body = {
    tags = local.tags
    properties = {
      sku = {
        name = "PerGB2018"
      }
      retentionInDays = 30
      features = {
        enableLogAccessUsingOnlyResourcePermissions = true
      }
    }
  }

  response_export_values = ["id", "name", "properties.customerId"]

  lifecycle {
    prevent_destroy = true
  }
}

resource "azapi_resource" "ai" {
  type      = "Microsoft.Insights/components@2020-02-02"
  parent_id = local.platform_rg_id
  name      = "appi-bccweb-${var.stamp_name}"
  location  = var.location

  body = {
    kind = "web"
    tags = local.tags
    properties = {
      Application_Type    = "web"
      WorkspaceResourceId = azapi_resource.law.id
      SamplingPercentage  = 25
    }
  }

  response_export_values = ["id", "name", "properties.ConnectionString"]

  lifecycle {
    prevent_destroy = true
  }
}

resource "azapi_resource" "acs_email" {
  type      = "Microsoft.Communication/emailServices@2025-09-01"
  name      = "acs-email-bccweb-${var.stamp_name}"
  parent_id = local.platform_rg_id
  location  = "global"
  tags      = local.tags

  body = {
    properties = {
      dataLocation = "Europe"
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azapi_resource" "acs_email_domain" {
  type      = "Microsoft.Communication/emailServices/domains@2025-09-01"
  name      = var.acs_email_domain
  parent_id = azapi_resource.acs_email.id
  location  = "global"
  tags      = local.tags

  body = {
    properties = {
      domainManagement = "CustomerManaged"
    }
  }

  response_export_values = ["properties.verificationRecords"]

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  acs_verification_records = try(
    azapi_resource.acs_email_domain.output.properties.verificationRecords,
    {}
  )

  acs_dns_records_for_operator = {
    domain_ownership = try(local.acs_verification_records.Domain, null)
    spf              = try(local.acs_verification_records.SPF, null)
    dkim             = try(local.acs_verification_records.DKIM, null)
    dkim2            = try(local.acs_verification_records.DKIM2, null)
    dmarc            = try(local.acs_verification_records.DMARC, null)
  }
}
