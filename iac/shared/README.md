# iac/shared — shared platform infrastructure

This Terraform root is the single shared layer used by the stable `staging`
and `prod` application environments. Bootstrap pre-creates
`rg-bccweb-shared`; this root consumes that resource-group name and never
creates the resource group itself.

## Resources

- **`monitoring.tf`**: one Log Analytics workspace (`log-bccweb-shared`,
  `PerGB2018`, 30-day retention) plus one Application Insights component per
  environment in `var.environments` (default `["staging", "prod"]`), each
  attached to that workspace.
- **`acs.tf`**: one Azure Communication Services email service + customer-managed
  domain, the configured sender username provisioned beneath that domain, plus one
  communication service (`acs-bccweb-shared`) linked to the domain. `listKeys` stays
  ephemeral — `acs.tf` never exports a connection string.
- **`swa.tf` + `dns.tf`**: one Standard-tier Static Web App (`swa-bccweb-shared`)
  shared by every environment, plus (when `production_hostname`/`dns_zone_name`
  are both set) the production custom-domain CNAME and `customDomains` child
  resource, ordered so DNS is created before Azure validates the domain.
- **`rbac.tf`**: leaf-scoped role assignments granting each environment's
  Terraform UMI (from required `var.env_umi_principal_ids`, which must contain
  every entry in `var.environments` and may contain additional keys such as
  `shared`) Monitoring Reader on its own Application Insights component, plus
  Contributor on the single shared ACS and SWA resources. No DNS or Owner
  assignment is granted here.

The complete non-secret output contract is **frozen at exactly nine outputs**
(enforced by `scripts/iac/check-shared-resource-contract.sh`, run in CI as
`npm run iac:platform-contract`): three stamp-consumed (`app_insights_ids`,
`acs_id`, `acs_sender_address`) and six deploy-workflow/operator-consumed
(`log_analytics_workspace_id`, `acs_email_domain_id`,
`acs_dns_records_for_operator`, `swa_name`, `swa_default_hostname`, `swa_id`).
None of the nine ever contain a `listKeys`, `ConnectionString`, or
`primaryConnectionString` value — see [OUTPUTS.md](OUTPUTS.md) for the full
contract.

## State and configuration

Remote state uses the committed `../env/shared.backend.hcl` configuration:
`shared.tfstate` in the `tfstate-shared` container of the canonical bootstrap
state account. Initialize and validate without connecting to that
backend with:

```sh
terraform -chdir=iac/shared init -backend=false
terraform -chdir=iac/shared validate
terraform -chdir=iac/shared fmt -check
```

For an authenticated plan against shared state, first sign in with `az login`
and copy/fill the local variables file from its example. Populate
`env_umi_principal_ids` from the bootstrap output:

```sh
cp iac/env/shared.tfvars.example iac/env/shared.tfvars
terraform -chdir=iac/bootstrap output -json terraform_umi_principal_ids
```

Then initialize the committed backend and plan with that var-file:

```sh
terraform -chdir=iac/shared init -backend-config=../env/shared.backend.hcl
terraform -chdir=iac/shared plan -var-file=../env/shared.tfvars
```

The root derives the active subscription ID from the AzAPI client context. Its
inputs are resource names, public host/domain configuration, tags, and the
environment UMI principal IDs used by its leaf-scoped role assignments; it
reads no passwords, access keys, connection strings, or other secret values.
Shared state must likewise expose resource identifiers and public metadata
only.

## Tests

```sh
terraform -chdir=iac/shared test -test-directory=tests/unit          # mocked, offline

terraform -chdir=iac/shared init -backend=false
terraform -chdir=iac/shared test -test-directory=tests/integration   # authenticated, plan-only
```
