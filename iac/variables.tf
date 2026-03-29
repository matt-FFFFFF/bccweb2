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

variable "jwt_secret" {
  description = "HS256 signing secret for issued JWTs (min 32 chars, random)"
  type        = string
  sensitive   = true
}

locals {
  prefix = "bccweb-${var.environment}"
  tags = {
    project     = "bccweb2"
    environment = var.environment
    managed_by  = "terraform"
  }
}
