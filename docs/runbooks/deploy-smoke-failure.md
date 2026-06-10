# Deploy smoke failure runbook

If the post-deploy smoke gate fails:

1. Check App Insights / Function App logs for errors.
2. Verify `vars.API_HOST` and `vars.WEB_HOST` are set correctly for the environment.
3. Re-run `terraform -chdir=iac apply -var-file=env/<env>.tfvars` — the new declarative secret pipeline will re-evaluate KV secret resources. If RBAC propagation lag caused a 403 on the first apply, a re-apply resolves it.
4. Manually roll back in Azure Portal if needed.

Notes:

- Do not rely on auto-rollback; the workflow intentionally fails so operators investigate immediately.
- Add the smoke workflow to main branch protection as a required status check in GitHub repo settings.
