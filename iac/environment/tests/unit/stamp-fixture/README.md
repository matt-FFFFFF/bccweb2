# stamp-fixture — Terraform test fixture for the stamp module

A near-verbatim copy of `iac/environment/modules/stamp/` used **only** by
`iac/environment/tests/unit/stamp.tftest.hcl`. Do not deploy this fixture to any
environment.

## Why this fixture exists

The real stamp module in `iac/environment/modules/stamp/keyvault.tf` declares two
`ephemeral` resources to seed Key Vault secrets without persisting plaintext
into Terraform state:

- `ephemeral "random_password" "jwt"`
- `ephemeral "azapi_resource_action" "acs_keys"`

Terraform's `mock_provider` framework (as of Terraform 1.11 / AzAPI 2.10)
cannot satisfy `ephemeral` resources during plan-time test runs — the planner
trips before the test assertions ever fire. To make `terraform test` succeed
against a representative module, this fixture substitutes the two ephemerals
with plain `random_password` resources whose values flow through ordinary
sentinel locals. That is acceptable in tests because no value reaches real
state.

## What this fixture contains

The directory mirrors `iac/environment/modules/stamp/` 1:1 with two intentional
exceptions:

- `keyvault.tf` substitutes the ephemerals for ordinary resources / sentinel
  locals. This is the only file that genuinely diverges.
- `variables.tf` redeclares the same variables as the real module. Terraform
  modules are independent units, so this duplication is required.

Everything else (`alerts.tf`, `functions.tf`, `outputs.tf`, `rg.tf`,
`storage.tf`, `versions.tf`) must remain byte-identical to the real module.

## Sync rule (diff-driven discipline)

Whenever any `iac/environment/modules/stamp/*.tf` file changes, update the matching
`iac/environment/tests/unit/stamp-fixture/*.tf` file in the same commit.

Quick check:

```sh
diff -r --exclude=keyvault.tf --exclude=variables.tf --exclude=README.md \
  iac/environment/modules/stamp iac/environment/tests/unit/stamp-fixture
```

The excluded files differ for these intentional reasons:

- this `README.md` (not present in the real module)
- the ephemeral substitution inside `keyvault.tf`
- the fixture-local redeclaration in `variables.tf`

Anything else means the fixture has drifted from the real module and must be
re-synced before merging.

## Future work

When Terraform's `mock_provider` framework gains support for `ephemeral`
resources, delete this fixture and point `iac/environment/tests/unit/stamp.tftest.hcl`
directly at `iac/environment/modules/stamp/`.
