#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
storage_file="$repo_root/iac/environment/modules/stamp/storage.tf"

fail() {
  printf 'Stamp storage split contract failed: %s\n' "$*" >&2
  exit 1
}

resource_records="$(awk '
  function brace_delta(value, copy, opens, closes) {
    copy = value
    opens = gsub(/\{/, "{", copy)
    copy = value
    closes = gsub(/\}/, "}", copy)
    return opens - closes
  }

  /^[[:space:]]*resource[[:space:]]+"azapi_resource"[[:space:]]+"[^"]+"[[:space:]]*\{/ {
    split($0, fields, "\"")
    resource_name = fields[4]
    resource_type = ""
    resource_parent = ""
    resource_azure_name = ""
    depth = brace_delta($0)
    in_resource = 1
    next
  }

  in_resource {
    if ($0 ~ /^[[:space:]]*type[[:space:]]*=/) {
      split($0, fields, "\"")
      resource_type = fields[2]
    } else if ($0 ~ /^[[:space:]]*name[[:space:]]*=/) {
      split($0, fields, "\"")
      resource_azure_name = fields[2]
    } else if ($0 ~ /^[[:space:]]*parent_id[[:space:]]*=/) {
      resource_parent = $0
      sub(/^[[:space:]]*parent_id[[:space:]]*=[[:space:]]*/, "", resource_parent)
    }
    depth += brace_delta($0)
    if (depth == 0) {
      print resource_name "\t" resource_type "\t" resource_azure_name "\t" resource_parent
      in_resource = 0
    }
  }
' "$storage_file")"

record_for() {
  local resource_name="$1"
  local record
  record="$(printf '%s\n' "$resource_records" | awk -F '\t' -v name="$resource_name" '$1 == name { print; found = 1 } END { if (!found) exit 1 }')" ||
    fail "missing azapi_resource.$resource_name"
  printf '%s\n' "$record"
}

assert_parent() {
  local resource_name="$1"
  local expected_parent="$2"
  local actual_parent
  actual_parent="$(record_for "$resource_name" | cut -f 4)"
  [[ "$actual_parent" == "$expected_parent" ]] ||
    fail "azapi_resource.$resource_name parent is '$actual_parent', expected '$expected_parent'"
}

assert_name() {
  local resource_name="$1"
  local expected_name="$2"
  local actual_name
  actual_name="$(record_for "$resource_name" | cut -f 3)"
  [[ "$actual_name" == "$expected_name" ]] ||
    fail "azapi_resource.$resource_name Azure name is '$actual_name', expected '$expected_name'"
}

assert_parent queue_service azapi_resource.storage_runtime.id
assert_parent blob_service_runtime azapi_resource.storage_runtime.id
assert_parent storage_container_deploy azapi_resource.blob_service_runtime.id
assert_name storage_container_deploy deploymentpackage

queue_resources=(
  queue_brief_pdf
  queue_brief_pdf_poison
  queue_signtofly_reflect
  queue_signtofly_reflect_poison
  queue_rescore_jobs
  queue_rescore_jobs_poison
  queue_igc_validation
  queue_igc_validation_poison
  queue_puretrack_group
  queue_puretrack_group_poison
)

for queue_resource in "${queue_resources[@]}"; do
  assert_parent "$queue_resource" azapi_resource.queue_service.id
done

assert_parent blob_service_data azapi_resource.storage_data.id
assert_parent storage_container_data azapi_resource.blob_service_data.id
assert_parent storage_container_data_private azapi_resource.blob_service_data.id
assert_parent storage_lifecycle azapi_resource.storage_data.id
assert_name storage_container_data data
assert_name storage_container_data_private data-private

queue_count="$(printf '%s\n' "$resource_records" | awk -F '\t' '$2 ~ /\/queueServices\/queues@/ { count++ } END { print count + 0 }')"
[[ "$queue_count" == "10" ]] || fail "expected exactly 10 queue resources, found $queue_count"

if printf '%s\n' "$resource_records" | awk -F '\t' '$2 ~ /\/queueServices(\/queues)?@/ && $4 ~ /storage_data/ { found = 1 } END { exit !found }'; then
  fail "a queue service or queue is parented to storage_data"
fi

if printf '%s\n' "$resource_records" | awk -F '\t' '$3 == "data" || $3 == "data-private" { if ($4 ~ /storage_runtime|blob_service_runtime/) found = 1 } END { exit !found }'; then
  fail "data or data-private is parented to storage_runtime"
fi

printf 'Runtime account: storage_runtime -> blob_service_runtime -> deploymentpackage; queue_service -> 10 queues\n'
printf 'Data account: storage_data -> blob_service_data -> data, data-private; storage_lifecycle\n'
printf 'Stamp storage split contract passed: no runtime/data crossover.\n'
