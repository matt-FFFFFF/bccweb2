# COMMITTED — no secrets. Replace the acs_email_domain placeholder with the
# real prod sending domain before the first apply.
# Use with:
#   terraform -chdir=iac/common init -backend-config=../env/common-prod.backend.hcl && terraform -chdir=iac/common apply -var-file=../env/common-prod.tfvars

stamp_name = "prod"
location   = "uksouth"
tags       = {}

# Per-env sending domain (e.g. mail.example.com) — keeps DNS verification
# and sender reputation isolated from dev.
acs_email_domain = "<REQUIRED: operator must replace before apply>"
