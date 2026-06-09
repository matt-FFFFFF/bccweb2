variable "location" {
  description = "Azure region for all resources"
  type        = string
  default     = "uksouth"
}

variable "environment" {
  description = "Environment name (prod, staging)"
  type        = string
  default     = "prod"
}

variable "allowed_origins" {
  description = "Allowed CORS origins for the storage account blob service; defaults to none so deploys fail closed unless tfvars supplies explicit SPA origins"
  type        = list(string)
  default     = []
}

# ─── Observability / Alert routing (T47) ──────────────────────────────────────
#
# `ops_email` is REQUIRED. There is no default so deploys fail closed unless
# the operator supplies a real on-call address — an alert without a recipient
# is worse than no alert.
#
# `slack_webhook_url` is optional. When non-empty, the action group adds a
# Slack-compatible webhook receiver in addition to email. When empty (default),
# only the email receiver is configured (no orphan webhook).

variable "ops_email" {
  description = "On-call email address that every alert rule routes to via the bccweb2 action group. Required: deploys fail closed if blank, because alerts without a recipient are worse than no alerts."
  type        = string

  validation {
    condition     = length(trimspace(var.ops_email)) > 0 && can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.ops_email))
    error_message = "var.ops_email must be a non-empty email address (alerts need a recipient)."
  }
}

variable "slack_webhook_url" {
  description = "Optional Slack-compatible incoming webhook URL added as a second receiver on the ops action group. Leave empty (default) to skip the webhook receiver."
  type        = string
  default     = ""
}

# ─── DNS / Production hostname (T51) ──────────────────────────────────────────
#
# `production_hostname` is the public-facing host the SPA will live at after
# DNS cutover (e.g. "bcc.flyparagliding.org.uk"). It is the LEFT-HAND SIDE of
# the CNAME that points at the SWA default hostname.
#
# `dns_zone_name` controls whether Terraform manages the CNAME or whether the
# operator creates it manually at their domain registrar:
#   - dns_zone_name = ""           → manual operator step (default). The SWA
#     default hostname is exposed via the `production_hostname_target` output
#     so the operator can paste it into their registrar.
#   - dns_zone_name = "example.com" → Terraform creates an azurerm_dns_cname
#     record in the matching Azure DNS zone (which must already exist and live
#     in the same subscription).
#
# The CNAME is intentionally a SCAFFOLD only — flipping live traffic is an
# operator action during the scheduled cutover window. See
# docs/runbooks/dns-cutover.md for the TTL strategy and runbook steps.

variable "production_hostname" {
  description = "Public-facing host the SPA serves traffic on after DNS cutover (e.g. 'bcc.flyparagliding.org.uk'). Becomes the LHS of the CNAME pointing at the SWA default hostname. Leave empty if cutover is not yet scheduled."
  type        = string
  default     = ""

  validation {
    condition     = var.production_hostname == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.production_hostname))
    error_message = "var.production_hostname must be empty or a lowercase DNS-valid hostname (letters/digits/hyphens, dots between labels)."
  }
}

variable "dns_zone_name" {
  description = "Name of an Azure DNS zone (e.g. 'flyparagliding.org.uk') that Terraform should manage. When set, an azurerm_dns_cname_record is created mapping var.production_hostname → SWA default hostname. When empty (default), the operator must create the CNAME manually at their registrar — see docs/runbooks/dns-cutover.md."
  type        = string
  default     = ""
}

variable "dns_zone_resource_group_name" {
  description = "Resource group containing var.dns_zone_name when DNS is hosted in Azure. Ignored when dns_zone_name is empty. Defaults to the same resource group as the rest of the bccweb stack."
  type        = string
  default     = ""
}

locals {
  prefix = "bccweb-${var.environment}"
  tags = {
    project     = "bccweb2"
    environment = var.environment
    managed_by  = "terraform"
  }
}
