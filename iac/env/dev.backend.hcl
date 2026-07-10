# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Use with:
#   terraform -chdir=iac/service init -backend-config=../env/dev.backend.hcl && terraform -chdir=iac/service apply -var-file=../env/dev.tfvars

resource_group_name  = "rg-bccweb-tfstate"
storage_account_name = "stbccwebtfstate813afe"
container_name       = "tfstate"
key                  = "dev.tfstate"
use_azuread_auth     = true
