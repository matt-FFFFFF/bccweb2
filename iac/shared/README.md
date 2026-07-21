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
  communication service (`acs-bccweb-shared`). The first apply leaves
  `linkedDomains` empty so Azure can expose DNS verification records. After the
  externally managed domain is verified, set `link_acs_email_domain = true` and
  re-apply to enable email. `listKeys` stays ephemeral — `acs.tf` never exports a
  connection string.
  The email service and communication service retain deletion protection;
  the customer-managed domain and sender children are replaceable so an
  unverified bootstrap domain can be corrected through a reviewed plan.
- **`swa.tf` + `dns.tf`**: one Standard-tier Static Web App (`swa-bccweb-shared`)
  in West Europe because Static Web Apps does not support Sweden Central,
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

For an authenticated plan against shared state, first sign in with `az login`.
`iac/env/shared.tfvars` is the committed, tracked base (`acs_email_domain`,
`acs_sender_address`, the empty DNS placeholders, tags, and `shared_rg_name`
— deterministic once `terraform_umis`/`github_environments` are fixed, so
it's committed rather than generated). The staging/prod/shared UMI principal
IDs do not exist before the first bootstrap apply, so bootstrap writes them to
`iac/env/shared.generated.tfvars`. This generated file is non-secret, mode
0644, and intentionally absent before that apply. Review and commit it before
running the shared root; there is no shared local overlay or GitHub Terraform
variable fallback.

```sh
terraform -chdir=iac/bootstrap apply
test -f iac/env/shared.generated.tfvars
git diff --no-index /dev/null iac/env/shared.generated.tfvars || test $? -eq 1
```

Then initialize the committed backend and plan with the authored base first
and bootstrap's generated file second:

```sh
terraform -chdir=iac/shared init -backend-config=../env/shared.backend.hcl
terraform -chdir=iac/shared plan -var-file=../env/shared.tfvars -var-file=../env/shared.generated.tfvars
```

The reusable workflow supplies the same second file through its shared-only
`TF_CLI_ARGS_plan`; environment-root plans receive no such argument. A missing
generated file therefore fails shared plan/apply/drift clearly. This is
expected until bootstrap has run and the reviewed file has been committed.

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
