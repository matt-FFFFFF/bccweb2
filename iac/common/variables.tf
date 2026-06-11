# Inputs for the per-env common (observability) stack. Per-env values live in
# ../env/common-<env>.tfvars (committed — nothing here is sensitive).

variable "stamp_name" {
  description = "Environment/stamp name used as the suffix in resource names (e.g. dev, prod)."
  type        = string
  nullable    = false
}

variable "location" {
  description = "Azure region for the deployment."
  type        = string
  default     = "uksouth"
}

variable "tags" {
  description = "Extra tags merged into the standard project tags."
  type        = map(string)
  default     = {}
}
