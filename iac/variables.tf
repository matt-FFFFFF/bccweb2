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

locals {
  prefix = "bccweb-${var.environment}"
  tags = {
    project     = "bccweb2"
    environment = var.environment
    managed_by  = "terraform"
  }
}
