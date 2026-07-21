# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

stamp_name = "staging"
location   = "uksouth"

tfstate_resource_group_name  = "rg-bccweb-tfstate"
tfstate_storage_account_name = "stbccweb13afe"
stamp_rg_name                = "stamp-staging"

allowed_origins = []
tags            = {}

jwt_secret_version = "1"
acs_secret_version = "1"
blob_schema_mode   = "observe"
