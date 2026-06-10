# Use with:
#   terraform -chdir=iac init -backend-config=env/prod.backend.hcl && terraform -chdir=iac apply -var-file=env/prod.tfvars

resource_group_name  = "rg-bccweb-tfstate"
storage_account_name = "<from bootstrap>"
container_name       = "tfstate"
key                  = "prod.tfstate"
use_azuread_auth     = true
