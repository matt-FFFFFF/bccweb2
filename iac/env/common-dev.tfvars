# COMMITTED — no secrets. The common stack only needs the stamp name + region.
# Use with:
#   terraform -chdir=iac/common init -backend-config=../env/common-dev.backend.hcl && terraform -chdir=iac/common apply -var-file=../env/common-dev.tfvars

stamp_name = "dev"
location   = "uksouth"
tags       = {}
