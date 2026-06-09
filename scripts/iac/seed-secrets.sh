#!/usr/bin/env bash
set -euo pipefail

# seed-secrets.sh — place out-of-band secrets into Key Vault after first apply.
#
# Run from the repo root or iac/ directory:
#   scripts/iac/seed-secrets.sh
#
# Prerequisites:
#   - terraform apply has already completed in iac/
#   - az login (or ARM_* env vars) with Key Vault Secrets Officer on the vault
#   - openssl available on PATH

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IAC_DIR="$SCRIPT_DIR/../../iac"

VAULT=$(terraform -chdir="$IAC_DIR" output -raw key_vault_name 2>/dev/null || true)

if [[ -z "$VAULT" ]]; then
  echo "ERROR: could not read key_vault_name from terraform output." >&2
  echo "       Run 'terraform apply' in iac/ first, then retry." >&2
  exit 1
fi

echo "Key Vault: $VAULT"

# ─── jwt-secret ──────────────────────────────────────────────────────────────

SECRET_NAME="jwt-secret"

if az keyvault secret show \
     --vault-name "$VAULT" \
     --name "$SECRET_NAME" \
     --query "id" -o tsv 2>/dev/null | grep -q .; then
  echo "[$SECRET_NAME] already exists — skipping (delete the secret version to rotate)"
else
  JWT="$(openssl rand -base64 64 | tr -d '\n')"
  az keyvault secret set \
    --vault-name "$VAULT" \
    --name "$SECRET_NAME" \
    --value "$JWT" \
    --output none
  unset JWT
  echo "[$SECRET_NAME] created"
fi

# ─── acs-connection-string ───────────────────────────────────────────────────
# The ACS connection string is currently still passed via Terraform app_settings.
# Wave 7 will move it here. This block is a placeholder for that migration.
#
# When ready, retrieve the value via:
#   az communication list-key \
#     --name acs-bccweb-prod \
#     --resource-group rg-bccweb-prod \
#     --query primaryConnectionString -o tsv
# then export ACS_CONNECTION_STRING=<value> and re-run this script.

ACS_SECRET="acs-connection-string"

if az keyvault secret show \
     --vault-name "$VAULT" \
     --name "$ACS_SECRET" \
     --query "id" -o tsv 2>/dev/null | grep -q .; then
  echo "[$ACS_SECRET] already exists — skipping"
elif [[ -n "${ACS_CONNECTION_STRING:-}" ]]; then
  az keyvault secret set \
    --vault-name "$VAULT" \
    --name "$ACS_SECRET" \
    --value "$ACS_CONNECTION_STRING" \
    --output none
  echo "[$ACS_SECRET] created"
else
  echo "[$ACS_SECRET] ACS_CONNECTION_STRING not set — skipping (Wave 7 migration)"
fi

echo ""
echo "Done. Secrets are in Key Vault '$VAULT'."
echo "The Function App resolves them at startup via @Microsoft.KeyVault references."
