#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
module_dir="${1:-$repo_root/iac/environment/modules/platform}"
lock_file="$repo_root/iac/environment/.terraform.lock.hcl"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/bccweb-platform-contract.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

cp "$module_dir"/*.tf "$work_dir/"
cp "$lock_file" "$work_dir/.terraform.lock.hcl"
sed '/^[[:space:]]*backend "azurerm" {}[[:space:]]*$/d' \
  "$repo_root/iac/environment/providers.tf" > "$work_dir/versions.tf"
terraform -chdir="$work_dir" init -backend=false -input=false -lockfile=readonly >/dev/null

actual="$({
  terraform -chdir="$work_dir" graph -type=plan |
    sed -nE 's/.*label = "(azapi_resource\.[^"]+)", shape = "box".*/\1/p'
} | LC_ALL=C sort)"
expected="$(printf '%s\n' \
  'azapi_resource.acs_email' \
  'azapi_resource.acs_email_domain' \
  'azapi_resource.ai' \
  'azapi_resource.law')"

if [[ "$actual" != "$expected" ]]; then
  printf 'Platform managed-resource contract failed.\nExpected:\n%s\nActual:\n%s\n' "$expected" "$actual" >&2
  exit 1
fi

printf 'Platform managed-resource contract passed: 4 exact resources.\n'
