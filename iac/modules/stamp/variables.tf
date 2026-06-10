# Required inputs from root: app_insights_id, app_insights_connection_string, log_analytics_workspace_id, terraform_principal_object_id.
#
# This is the stamp module's input schema. The root module declares the same
# user-facing variable names in iac/variables.tf and forwards them into the
# module call (intentional duplicate per Terraform module practice). Plaintext
# secret values (e.g. jwt_secret) MUST NOT be declared here — they are seeded
# into Key Vault out-of-band; rotation triggers are passed as version inputs.

# ─── Forwarded from root ──────────────────────────────────────────────────────

variable "stamp_name" {
  description = "Environment/stamp name used as the suffix in resource names."
  type        = string
  nullable    = false
}

variable "location" {
  description = "Azure region for the deployment."
  type        = string
  nullable    = false
}

variable "allowed_origins" {
  description = "Allowed CORS origins for the storage blob service."
  type        = list(string)
  default     = []
}

variable "ops_email" {
  description = "Alert recipient email address."
  type        = string
  nullable    = false
}

variable "slack_webhook_url" {
  description = "Optional Slack webhook URL for alerts."
  type        = string
  default     = ""
}

variable "production_hostname" {
  description = "Public hostname for DNS cutover."
  type        = string
  default     = ""
}

variable "dns_zone_name" {
  description = "Azure DNS zone name for managed cutover."
  type        = string
  default     = ""
}

variable "dns_zone_resource_group_name" {
  description = "Resource group containing the Azure DNS zone."
  type        = string
  default     = ""
}

variable "acs_email_domain" {
  description = "ACS email sending domain (e.g. mail.example.com)."
  type        = string
  nullable    = false
}

variable "acs_sender_address" {
  description = "Full ACS sender address (e.g. noreply@mail.example.com)."
  type        = string
  nullable    = false
}

variable "round_brief_emails" {
  description = "Comma-separated round brief recipient addresses."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "puretrack_api_key" {
  description = "PureTrack API key for the BCC account."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "puretrack_email" {
  description = "PureTrack login email for the BCC account."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "puretrack_password" {
  description = "PureTrack login password for the BCC account."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "jwt_secret_version" {
  description = "Rotation trigger for the JWT secret copy in Key Vault."
  type        = string
  default     = "1"
}

variable "acs_secret_version" {
  description = "Rotation trigger for the ACS connection-string copy in Key Vault."
  type        = string
  default     = "1"
}

variable "tags" {
  description = "Tags applied to every resource in the stamp."
  type        = map(string)
  default     = {}
}

# ─── Required inputs from root ────────────────────────────────────────────────
#
# These four are produced by the root module (shared cross-stamp observability
# + the Terraform principal identity) and forwarded into every stamp instance.
# They have no sensible defaults — the module must refuse to plan without them.

variable "app_insights_id" {
  description = "Resource ID of the shared Application Insights component (REQUIRED INPUT from root)."
  type        = string
  nullable    = false
}

variable "app_insights_connection_string" {
  description = "Application Insights connection string forwarded from root into Key Vault via the ephemeral pipeline (REQUIRED INPUT from root)."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "log_analytics_workspace_id" {
  description = "Resource ID of the shared Log Analytics workspace (REQUIRED INPUT from root)."
  type        = string
  nullable    = false
}

variable "terraform_principal_object_id" {
  description = "Object ID of the Terraform-running principal; granted Key Vault Secrets Officer for data-plane writes (REQUIRED INPUT from root)."
  type        = string
  nullable    = false
}
