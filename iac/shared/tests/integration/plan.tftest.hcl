# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# REQUIRES ambient `az login`. Plan-only; NEVER `apply`.
# Run:
#   terraform -chdir=iac/shared init -backend=false
#   terraform -chdir=iac/shared test -test-directory=tests/integration

provider "azapi" {}

variables {
  shared_rg_name     = "rg-bccweb-shared"
  acs_email_domain   = "mail.integration-test.example.invalid"
  acs_sender_address = "no-reply@mail.integration-test.example.invalid"
}

run "plan_against_real_provider" {
  command = plan

  expect_failures = []
}
