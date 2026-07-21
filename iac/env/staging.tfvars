# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

stamp_name = "staging"
location   = "swedencentral"

tfstate_resource_group_name  = "rg-bccweb-tfstate"
tfstate_storage_account_name = "stbccweb13afe"
stamp_rg_name                = "stamp-staging"

# Initial provisioning only: no origins means Blob Storage emits no CORS rule.
# Replace with the shared SWA's HTTPS origin and re-apply before browser SPA use.
allowed_origins = []
tags            = {}

jwt_secret_version = "1"
acs_secret_version = "1"
blob_schema_mode   = "observe"
