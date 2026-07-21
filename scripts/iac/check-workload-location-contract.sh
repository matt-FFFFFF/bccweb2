#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

set -euo pipefail

expected='location = "swedencentral"'
for config in iac/env/shared.tfvars iac/env/staging.tfvars iac/env/prod.tfvars; do
  actual="$(grep -E '^[[:space:]]*location[[:space:]]*=' "$config" | tr -s '[:space:]' ' ' | sed -E 's/^ //; s/ $//')"
  if [[ "$actual" != "$expected" ]]; then
    printf 'ERROR: %s must contain exactly %s; found %s\n' "$config" "$expected" "$actual" >&2
    exit 1
  fi
done

printf 'Workload location contract passed: shared, staging, and prod use swedencentral.\n'
