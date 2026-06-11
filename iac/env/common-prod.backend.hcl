# Use with:
#   terraform -chdir=iac/common init -backend-config=../env/common-prod.backend.hcl && terraform -chdir=iac/common apply -var-file=../env/common-prod.tfvars

resource_group_name  = "rg-bccweb-tfstate"
storage_account_name = "stbccwebtfstate813afe"
container_name       = "tfstate"
key                  = "common-prod.tfstate"
use_azuread_auth     = true
