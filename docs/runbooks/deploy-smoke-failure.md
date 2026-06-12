# Deploy failure runbook

Covers failures in `deploy-dev.yml` (push to `main`) and `deploy-prod.yml`
(release published). Both share three failure classes: the terraform drift
gate, the post-deploy smoke gate, and (prod only) the release-ancestry check.

## Smoke-test failures (`deploy-api` / `deploy-web` jobs)

If the post-deploy smoke gate fails:

1. Check App Insights / Function App logs for errors.
2. Verify `vars.API_HOST` and `vars.WEB_HOST` are set correctly for the environment (env-scoped GitHub vars).
3. Re-run the service apply — `gh workflow run terraform.yml -f stack=service -f env=<env> -f mode=apply` — the declarative secret pipeline will re-evaluate KV secret resources. If RBAC propagation lag caused a 403 on the first apply, a re-apply resolves it.
4. Manually roll back in Azure Portal if needed.

## terraform-check failures (drift gate)

The first deploy job plans the service stack with `-detailed-exitcode`; any
drift or pending change (exit code 2) fails the run **before** app code
deploys.

1. Read the plan diff in the failed run's step summary (`gh run view <id>` or the Actions UI) — it shows exactly what differs.
2. Expected change (e.g. a merged iac/ edit)? Apply it: `gh workflow run terraform.yml -f stack=service -f env=<env> -f mode=apply`, wait for success, then re-run the failed deploy (or push/re-publish).
3. Unexpected drift (portal edit, partial apply)? Investigate before applying — the plan diff names the drifted resources.

## verify-release-ancestry failures (prod only)

The prod workflow refuses releases whose commit is not reachable from `main`.

1. Confirm: `git merge-base --is-ancestor <release-sha> origin/main; echo $?` — non-zero means the commit is not on main.
2. Fix by merging the work to `main` first, then either delete + re-create the release on the merged commit, or retag: `git tag -f <tag> <main-sha> && git push -f origin <tag>`, delete the old release, and publish a new one.
3. Never bypass the check by editing the workflow — it exists so prod can only run code that main-based dev already ran.

Notes:

- Do not rely on auto-rollback; the workflows intentionally fail so operators investigate immediately.
- Add the `deploy-dev.yml` jobs to main branch protection as required status checks in GitHub repo settings.
