# Deploy smoke failure runbook

If the post-deploy smoke gate fails:

1. Check App Insights / Function App logs for errors.
2. Verify `vars.API_HOST` and `vars.WEB_HOST` are set correctly for the environment.
3. Verify Key Vault secret seeding completed successfully (`jwt-secret`, ACS config).
4. Manually roll back in Azure Portal if needed.

Notes:

- Do not rely on auto-rollback; the workflow intentionally fails so operators investigate immediately.
- Add the smoke workflow to main branch protection as a required status check in GitHub repo settings.
