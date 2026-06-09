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

locals {
  prefix = "bccweb-${var.environment}"
  tags = {
    project     = "bccweb2"
    environment = var.environment
    managed_by  = "terraform"
  }
}
