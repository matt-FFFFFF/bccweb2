# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Per-env common stack: Log Analytics workspace + Application Insights + ACS
# email service/domain. These outlive service-stack churn — in particular the
# DNS-verified email domain, whose registrar records and sender reputation
# must survive stamp rebuilds.
# Run: terraform -chdir=iac/common init -backend-config=../env/common-<env>.backend.hcl && terraform -chdir=iac/common apply -var-file=../env/common-<env>.tfvars
#
# The platform RG is pre-created by iac/bootstrap — this stack never reads or
# manages it; its ID is fully determined by subscription + name, so resources
# just interpolate it. The service stack reads this stack's outputs via
# terraform_remote_state (key common-<env>.tfstate).

data "azapi_client_config" "current" {}

# Standard project tags, matching the service stack's shape.
locals {
  platform_rg_name = "rg-bccweb-platform-${var.stamp_name}"
  platform_rg_id   = "/subscriptions/${data.azapi_client_config.current.subscription_id}/resourceGroups/${local.platform_rg_name}"

  tags = merge(var.tags, {
    project     = "bccweb"
    environment = var.stamp_name
    managed_by  = "terraform"
  })
}

# ─── Log Analytics workspace (per-env sink) ───────────────────────────────────

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
}

# ─── Application Insights (workspace-based) ───────────────────────────────────

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
}

# ─── ACS Email Service + CustomerManaged domain ───────────────────────────────
#
# Only the email service and its DNS-verified domain live here — they are the
# slow-to-recreate pets (registrar records + verification wait + sender
# reputation). The communicationServices resource, its access keys, and the
# Key Vault seeding all stay in the service stack, which links this domain
# cross-stack by ID (`linkedDomains`) via remote state. The access key grants
# send rights on every linked domain, so keeping it per-stamp preserves the
# env blast-radius isolation.
#
# After applying, run `terraform -chdir=iac/common output acs_dns_records_for_operator`
# and add every returned record at your domain registrar before the Azure
# portal will mark the domain Verified.

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
}

# ─── Verification-record decomposition ───────────────────────────────────────
#
# Azure ACS returns `properties.verificationRecords` as an object with keys
# Domain (ownership TXT), SPF (TXT), DKIM (CNAME), DKIM2 (CNAME) and DMARC
# (TXT). The operator must paste each record at their DNS registrar before the
# Azure portal will mark the domain Verified.
#
# DMARC policy guidance: the suggested DMARC TXT value returned by Azure is a
# starter record. For first deployment publish it with `p=none` so a
# misconfigured SPF/DKIM does NOT cause mail to be silently dropped. After at
# least one full week of clean delivery + monitored DMARC aggregate reports,
# tighten to `p=quarantine` and eventually `p=reject`.

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
