# COMMITTED — no secrets. Replace the acs_email_domain placeholder with the
# real dev sending domain before the first apply.
# Use with:
#   terraform -chdir=iac/common init -backend-config=../env/common-dev.backend.hcl && terraform -chdir=iac/common apply -var-file=../env/common-dev.tfvars

stamp_name = "dev"
location   = "uksouth"
tags       = {}

# Per-env sending domain (e.g. dev-mail.example.com) — keeps DNS verification
# and sender reputation isolated from prod.
acs_email_domain = "<REQUIRED: operator must replace before apply>"
