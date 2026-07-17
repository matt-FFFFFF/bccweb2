# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Use with:
#   terraform -chdir=iac/environment init -backend-config=../env/staging.backend.hcl

resource_group_name  = "rg-bccweb-tfstate"
storage_account_name = "stbccweb13afe"
container_name       = "tfstate-staging"
key                  = "staging.tfstate"
use_azuread_auth     = true
