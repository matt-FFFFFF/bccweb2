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
  description = "Allowed CORS origins for the storage account blob service (no wildcards in production)"
  type        = list(string)
  default     = []
}

locals {
  prefix = "bccweb-${var.environment}"
  tags = {
    project     = "bccweb2"
    environment = var.environment
    managed_by  = "terraform"
  }
}
