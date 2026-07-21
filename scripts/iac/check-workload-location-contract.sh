#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

set -euo pipefail

for config in \
  iac/bootstrap/terraform.tfvars \
  iac/bootstrap/terraform.tfvars.example \
  iac/shared/variables.tf \
  iac/environment/variables.tf \
  iac/env/shared.tfvars \
  iac/env/shared.tfvars.example \
  iac/env/staging.tfvars \
  iac/env/staging.tfvars.example \
  iac/env/prod.tfvars \
  iac/env/prod.tfvars.example; do
  if [[ "$config" == */variables.tf ]]; then
    actual="$(grep -A3 '^variable "location"' "$config" | grep -E '^[[:space:]]*default[[:space:]]*=' | tr -s '[:space:]' ' ' | sed -E 's/^ //; s/ $//')"
    expected='default = "swedencentral"'
  else
    actual="$(grep -E '^[[:space:]]*location[[:space:]]*=' "$config" | tr -s '[:space:]' ' ' | sed -E 's/^ //; s/ $//')"
    expected='location = "swedencentral"'
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf 'ERROR: %s must contain exactly %s; found %s\n' "$config" "$expected" "$actual" >&2
    exit 1
  fi
done

printf 'Location contract passed: bootstrap, shared, staging, and prod use swedencentral.\n'

for config in iac/env/shared.tfvars iac/env/shared.tfvars.example; do
  if ! grep -Eq '^[[:space:]]*swa_location[[:space:]]*=[[:space:]]*"westeurope"[[:space:]]*$' "$config"; then
    printf 'ERROR: %s must set the supported SWA exception swa_location = "westeurope".\n' "$config" >&2
    exit 1
  fi
done

if ! grep -A3 '^variable "swa_location"' iac/shared/variables.tf | grep -Eq '^[[:space:]]*default[[:space:]]*=[[:space:]]*"westeurope"[[:space:]]*$'; then
  printf 'ERROR: iac/shared/variables.tf must default swa_location to the supported West Europe region.\n' >&2
  exit 1
fi
