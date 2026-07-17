# iac/shared — shared platform infrastructure

This Terraform root is the single shared layer used by the stable `staging`
and `prod` application environments. Bootstrap pre-creates
`rg-bccweb-shared`; this root consumes that resource-group name and never
creates the resource group itself.

The scaffold intentionally contains no resources yet. Follow-on topology work
adds the shared Log Analytics workspace and per-environment Application
Insights components (T6), Azure Communication Services (T7), the Standard
Static Web App and production DNS/custom domain (T8), and narrowly scoped
cross-resource-group RBAC for environment identities (T23). Resource-specific
files own their outputs; the complete non-secret output contract is frozen in
T9.

## State and configuration

Remote state uses the committed `../env/shared.backend.hcl` configuration:
`shared.tfstate` in the `tfstate-shared` container of the canonical bootstrap
state account. Initialize and validate the scaffold without connecting to that
backend with:

```sh
terraform -chdir=iac/shared init -backend=false
terraform -chdir=iac/shared validate
terraform -chdir=iac/shared fmt -check
```

For an authenticated plan against shared state, first sign in with `az login`
and initialize the committed backend:

```sh
terraform -chdir=iac/shared init -backend-config=../env/shared.backend.hcl
terraform -chdir=iac/shared plan
```

The root derives the active subscription ID and Terraform caller object ID from
the AzAPI client context. Its inputs are resource names, public host/domain
configuration, tags, principal IDs, and principal type only; it reads no
passwords, access keys, connection strings, or other secret values. Shared
state must likewise expose resource identifiers and public metadata only.
