# PR-1 OPS — bootstrap evolution runbook

**When to run**: After PR 1's code is on a reviewed branch but BEFORE the PR is merged.
The bootstrap uses local state (`iac/bootstrap/terraform.tfstate` is gitignored), so the
operator runs this from a local checkout of the feature branch. Acceptance-gate success
is the prerequisite for merging the PR. Azure-side changes persist regardless of PR
merge outcome.

Order: (1) operator pulls feature branch locally → (2) executes this runbook → (3) all
acceptance gates pass → (4) PR gets reviewed + merged → (5) Wave 2 begins.

## Pre-flight backups

- `cp iac/bootstrap/terraform.tfstate /tmp/bootstrap-before-$(date +%s).tfstate`
- `terraform -chdir=iac init -backend-config=env/prod.backend.hcl`
- `terraform -chdir=iac state pull > /tmp/prod-before-$(date +%s).tfstate`
- Capture for later verification: `az monitor log-analytics workspace show -g rg-bccweb-platform-prod -n log-bccweb-prod --query id -o tsv > /tmp/law-id-before.txt`; `az monitor app-insights component show -g rg-bccweb-platform-prod -a appi-bccweb-prod --query id -o tsv > /tmp/ai-id-before.txt`; `az resource list -g rg-bccweb-prod --query "length([])" -o tsv > /tmp/prod-count-before.txt`.

## Prerequisites

- `az login` as a principal with subscription Owner (human; the old single subscription-scope-Owner UMI is being destroyed by this apply).
- `export GITHUB_TOKEN=<PAT with repo + Environments + Secrets write on matt-FFFFFF/bccweb2>`.
- `cp iac/bootstrap/terraform.tfvars.example iac/bootstrap/terraform.tfvars` (adjust `tfstate_storage_account_name` to the live SA name if it differs).

## Init

- `terraform -chdir=iac/bootstrap init`

## Pre-apply imports (so bootstrap adopts existing prod RGs)

- `SUB=$(az account show --query id -o tsv)`
- `terraform -chdir=iac/bootstrap import 'azapi_resource.pre_created_rg["platform-prod"]' /subscriptions/$SUB/resourceGroups/rg-bccweb-platform-prod`
- `terraform -chdir=iac/bootstrap import 'azapi_resource.pre_created_rg["stamp-prod"]' /subscriptions/$SUB/resourceGroups/rg-bccweb-prod`
- (No imports for `platform-dev` or `stamp-dev` — these RGs do not yet exist; bootstrap will create them.)

## Plan + apply

- `terraform -chdir=iac/bootstrap plan -out=tfplan`
- Expected CREATE: 2 RGs (`rg-bccweb-platform-dev`, `rg-bccweb-dev`); 2 UMIs (`id-bccweb-terraform-dev`, `id-bccweb-terraform-prod`); 2 FICs; 4 RG-scoped Owner role assignments; 2 Storage Blob Data Contributor role assignments on tfstate SA; 1 new GitHub env (`dev`); 6 env-scoped secrets.
- Expected DESTROY: 1 single `azapi_resource.tf_umi`; 1 subscription-scope Owner role assignment; 1 old single FIC; 3 old secrets on the `prod` env (recreated immediately with new clientId).
- The 2 imported prod RGs may show an in-place tags update (the old root config tagged them; bootstrap normalises tags). No destroy of either imported RG is acceptable.
- `terraform -chdir=iac/bootstrap apply tfplan`

## Verification (run all five; all must pass)

- `gh secret list --env dev --repo matt-FFFFFF/bccweb2 | grep -E 'AZURE_(CLIENT|TENANT|SUBSCRIPTION)_ID' | wc -l` → 3
- `gh secret list --env prod --repo matt-FFFFFF/bccweb2 | grep -E 'AZURE_(CLIENT|TENANT|SUBSCRIPTION)_ID' | wc -l` → 3
- `az identity list -g rg-bccweb-tfstate --query "[?contains(name,'bccweb-terraform')].name" -o tsv | sort` → exactly `id-bccweb-terraform-dev` and `id-bccweb-terraform-prod` (no bare `id-bccweb-terraform`).
- For each UMI: `az role assignment list --all --assignee $(az identity show -n id-bccweb-terraform-<env> -g rg-bccweb-tfstate --query principalId -o tsv) --query "[].{role:roleDefinitionName,scope:scope}" -o tsv` → exactly 2 Owner (one each for platform-<env> RG and stamp-<env> RG) + 1 Storage Blob Data Contributor (scope = tfstate SA).
- Old subscription-scope Owner assignment gone: `az role assignment list --all --scope /subscriptions/$SUB --role Owner --query "[?contains(principalId, '<OLD UMI principalId from backup>')]" -o tsv` → empty.

## Rollback

The bootstrap apply is not transactional — if it fails midway, fix the cause
and re-apply (resources are idempotent). To revert wholesale:

1. Restore local state: `cp /tmp/bootstrap-before-<timestamp>.tfstate iac/bootstrap/terraform.tfstate`.
2. Check out the pre-refactor bootstrap code (`git checkout main -- iac/bootstrap/`).
3. `terraform -chdir=iac/bootstrap apply` to converge back to the single-UMI layout.
4. Note: the new per-env UMIs/RGs created by the failed attempt are NOT in
   the restored state — delete them manually (`az identity delete`,
   `az group delete` for the two dev RGs) after confirming nothing uses them.
