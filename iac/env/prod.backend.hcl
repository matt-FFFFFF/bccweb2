# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Use with:
#   terraform -chdir=iac/environment init -backend-config=../env/prod.backend.hcl && terraform -chdir=iac/environment apply -var-file=../env/prod.tfvars

resource_group_name  = "rg-bccweb-tfstate"
storage_account_name = "stbccwebtfstate813afe"
container_name       = "tfstate"
key                  = "prod.tfstate"
use_azuread_auth     = true
