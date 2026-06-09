# ─── Log Analytics + Application Insights ────────────────────────────────────
#
# Workspace-based Application Insights (the only flavour Azure still accepts
# for new deployments). Telemetry from the Function App and the SPA RUM
# instrumentation lands in this workspace.
#
# Cost / retention:
#   - PerGB2018 (pay-as-you-go) workspace, 30-day retention.
#   - Function App sets APPINSIGHTS_SAMPLING_PERCENTAGE=25 to cap request
#     telemetry volume; exceptions and failed requests are exempted from
#     sampling in code (see apps/api/src/lib/telemetry.ts).
#
# Connection string handling — SAME PATTERN AS T7 JWT_SECRET:
#   - The plaintext connection string is NEVER written to Terraform state.
#   - scripts/iac/seed-secrets.sh reads the value from this resource at
#     bootstrap time and places it into Key Vault as
#     'appinsights-connection-string'.
#   - The Function App reads it at runtime via the
#     @Microsoft.KeyVault(...) reference syntax in functions.tf app_settings,
#     resolved through its system-assigned managed identity.
#
# Outputs:
#   - application_insights_name           (used by alert rules in T47)
#   - application_insights_resource_id    (alert action group scope)
#   - log_analytics_workspace_id          (KQL queries from CLI / Portal)
#
# Local development:
#   APPLICATIONINSIGHTS_CONNECTION_STRING is left unset in
#   apps/api/local.settings.json. telemetry.setup() detects the missing env
#   var and no-ops with a single warning log line, so startup is not blocked.

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${local.prefix}"
  location            = azapi_resource.resource_group.location
  resource_group_name = azapi_resource.resource_group.name
  sku                 = "PerGB2018"
  retention_in_days   = 30

  tags = local.tags
}

resource "azurerm_application_insights" "main" {
  name                = "appi-${local.prefix}"
  location            = azapi_resource.resource_group.location
  resource_group_name = azapi_resource.resource_group.name
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "Node.JS"

  # 25% sampling on the server side keeps cost predictable; the SDK in
  # telemetry.ts opts errors/dependencies out of sampling in code so
  # incident triage data is never thrown away.
  sampling_percentage = 25

  tags = local.tags
}
