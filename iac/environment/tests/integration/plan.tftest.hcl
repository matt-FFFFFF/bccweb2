# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# REQUIRES ambient 'az login' AND backend init. Plan-only; NEVER 'apply'.
# Run:
#   terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl
#   terraform -chdir=iac/environment test -test-directory=tests/integration -var-file=../env/<env>.tfvars
#
# This file is the INTEGRATION counterpart to tests/unit/stamp.tftest.hcl.
# Unlike the unit tests (which mock_provider every provider for offline runs),
# this test talks to the REAL azapi provider against a real subscription.
# It only PLANs — it never APPLIES — so it is safe to run on a clean
# subscription, but it still requires:
#   * Ambient `az login` so azapi can authenticate.
#   * A backend init (`-backend-config=../env/<env>.backend.hcl`) for the
#     operator's selected environment.
#   * A `-var-file` supplying the real `puretrack_*`, ACS, ops_email, etc.
#
# This file is intentionally excluded from default `terraform test` runs
# (the default `-test-directory=tests` discovery picks up tests/unit/ only
# when invoked explicitly). CI runs unit tests by default; integration is
# an operator-invoked check.

provider "azapi" {}

variables {
  stamp_name = "integration-test"
  location   = "uksouth"

  stamp_rg_name = "rg-bccweb-integration-test"

  tfstate_resource_group_name  = "rg-bccweb-tfstate"
  tfstate_storage_account_name = "stbccweb13afe"

  allowed_origins = ["https://integration-test.example.invalid"]

  ops_email         = "ops-integration-test@example.invalid"
  slack_webhook_url = ""

  acs_sender_address = "no-reply@integration-test.example.invalid"

  # Sentinel values — never real secrets. The plan-only invocation does not
  # write these anywhere; they only need to satisfy `nullable = false`.
  puretrack_api_key  = "TEST_PURETRACK_API_KEY"
  puretrack_email    = "TEST_PURETRACK_EMAIL@example.invalid"
  puretrack_password = "TEST_PURETRACK_PASSWORD"

  jwt_secret_version = "1"
  acs_secret_version = "1"

}

run "plan_against_real_backend" {
  command = plan

  # Plan must succeed (no expected failures against a healthy real backend).
  expect_failures = []

  # Guardrail: the root module must actually be planning the stamp module.
  # If `module "stamp"` is misconfigured or accidentally gated to zero
  # instances, planned_values.root_module.child_modules would be empty
  # and we'd silently pass on a degenerate no-op.
  assert {
    condition     = length(run.plan_against_real_backend.planned_values.root_module.child_modules) == 1
    error_message = "Root module must plan exactly one stamp child module."
  }
}
