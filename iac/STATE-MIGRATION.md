# PR-2 OPS — iac/ split + state migration runbook

**When to run**: After PR 2's code is on a reviewed branch but BEFORE the PR is merged.
The migration uses `terraform import` + `state rm` operations on the REMOTE prod tfstate;
those changes persist regardless of PR merge status. The operator runs this from a local
checkout of the feature branch. Acceptance-gate success is the prerequisite for merging
the PR.

Order: (1) operator pulls feature branch locally → (2) executes this runbook → (3) all
5 acceptance gates pass → (4) PR gets reviewed + merged → (5) Wave 3 begins.

## Pre-flight

- PR-1 OPS must have completed (2 UMIs + 4 RGs + GitHub secrets all in place — see
  [bootstrap/MIGRATION-OPS.md](bootstrap/MIGRATION-OPS.md)).
- Pre-flight backups from PR-1 OPS (prod tfstate, bootstrap tfstate, captured LAW/AI ids)
  must still exist in `/tmp/`. If lost, redo PR-1 OPS pre-flight backup steps before
  proceeding.

## Migration commands (run in order)

1. `terraform -chdir=iac/common init -backend-config=../env/common-prod.backend.hcl` — initialises the new empty `common-prod.tfstate`.
2. `terraform -chdir=iac/service init -backend-config=../env/prod.backend.hcl` — reconnects to the existing prod tfstate (now scoped to the service stack).
3. `SUB=$(az account show --query id -o tsv)`
4. `terraform -chdir=iac/common import -var-file=../env/common-prod.tfvars azapi_resource.law /subscriptions/$SUB/resourceGroups/rg-bccweb-platform-prod/providers/Microsoft.OperationalInsights/workspaces/log-bccweb-prod`
5. `terraform -chdir=iac/common import -var-file=../env/common-prod.tfvars azapi_resource.ai /subscriptions/$SUB/resourceGroups/rg-bccweb-platform-prod/providers/Microsoft.Insights/components/appi-bccweb-prod`
6. `terraform -chdir=iac/service state rm azapi_resource.platform azapi_resource.law azapi_resource.ai 'module.stamp.azapi_resource.rg'`

The platform RG and stamp RG are NOT imported anywhere here — PR-1 OPS already
imported them into the bootstrap state; the common and service stacks reference
them by interpolated name/ID without managing them.

## Acceptance gates (all five must pass before proceeding to PR 3)

1. `terraform -chdir=iac/common plan -var-file=../env/common-prod.tfvars -detailed-exitcode` → exit code 0 (no changes).
2. `terraform -chdir=iac/service plan -var-file=../env/prod.tfvars -detailed-exitcode` → exit code 0 (no changes; requires the gitignored `iac/env/prod.tfvars` to exist locally — operator copies from `prod.tfvars.example` and populates with real values including the new `tfstate_sa_name`, or sets all sensitive values via `TF_VAR_*` env).
3. `az monitor log-analytics workspace show -g rg-bccweb-platform-prod -n log-bccweb-prod --query id -o tsv > /tmp/law-id-after.txt && diff /tmp/law-id-before.txt /tmp/law-id-after.txt` → diff exit 0.
4. `az monitor app-insights component show -g rg-bccweb-platform-prod -a appi-bccweb-prod --query id -o tsv > /tmp/ai-id-after.txt && diff /tmp/ai-id-before.txt /tmp/ai-id-after.txt` → diff exit 0.
5. `az resource list -g rg-bccweb-prod --query "length([])" -o tsv > /tmp/prod-count-after.txt && diff /tmp/prod-count-before.txt /tmp/prod-count-after.txt` → diff exit 0.

## Rollback (if any acceptance gate fails)

1. `terraform -chdir=iac/service init -backend-config=../env/prod.backend.hcl`
2. `terraform -chdir=iac/service state push /tmp/prod-before-<timestamp>.tfstate` — restores the prod tfstate to its pre-migration shape.
3. Remove the two imports from the new common state: `terraform -chdir=iac/common state rm azapi_resource.law azapi_resource.ai` (the Azure resources are untouched either way — state surgery only).
4. Verify: `git stash` (or check out `main`), then `terraform -chdir=iac plan -var-file=env/prod.tfvars` with the OLD code reports the LAW/AI/platform RG/stamp RG as currently-managed again.
5. Coordinate before retrying — investigate which acceptance gate failed and why.
