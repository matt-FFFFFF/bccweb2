terraform {
  required_version = "~> 1.11"

  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.10"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.4"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.9"
    }
  }
}

# The github provider authenticates via the GITHUB_TOKEN env var (default
# behavior). When `manage_github_secrets = false`, every github_* resource is
# gated off, so the provider is never invoked and the token can be absent.
provider "github" {
  owner = split("/", var.github_repo)[0]
}

