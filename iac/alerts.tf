# ─── Monitor Action Group ────────────────────────────────────────────────────
#
# Single action group fans out every alert rule below to the on-call email and,
# optionally, a Slack-compatible incoming webhook. No alert in this file uses
# any other action group — operators have ONE place to update routing.
#
# short_name is capped at 12 chars by the Azure API; it appears as the SMS /
# voice prefix and must be human-recognisable.

resource "azurerm_monitor_action_group" "ops" {
  name                = "ag-${local.prefix}-ops"
  resource_group_name = azapi_resource.resource_group.name
  short_name          = "bccops"
  enabled             = true

  email_receiver {
    name                    = "ops"
    email_address           = var.ops_email
    use_common_alert_schema = true
  }

  dynamic "webhook_receiver" {
    for_each = var.slack_webhook_url != "" ? [var.slack_webhook_url] : []
    content {
      name                    = "slack"
      service_uri             = webhook_receiver.value
      use_common_alert_schema = true
    }
  }

  tags = local.tags
}

# ─── Alert 1: HTTP 5xx rate > 1% over 5min (severity 1) ──────────────────────
#
# Scheduled query against App Insights — required because Microsoft.Web/sites
# exposes `Http5xx` and `Requests` as separate metrics with no built-in ratio
# operator. KQL computes errors/total over the 5-minute evaluation window and
# guards against false positives on near-zero traffic (errors must also be >= 5
# absolute, not just exceed the 1% rate).
#
# Severity 1 (page): user-facing API errors are real fires.

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "api_5xx_rate" {
  name                 = "alert-${local.prefix}-api-5xx-rate"
  resource_group_name  = azapi_resource.resource_group.name
  location             = azapi_resource.resource_group.location
  evaluation_frequency = "PT5M"
  window_duration      = "PT5M"
  scopes               = [azurerm_application_insights.main.id]
  severity             = 1

  description = "Function App HTTP 5xx error rate exceeded 1% over 5 minutes (with absolute floor of 5 errors). Triage via docs/runbooks/alerts.md#api-5xx-rate."

  criteria {
    query                   = <<-KQL
      requests
      | where timestamp > ago(5m)
      | summarize total = count(), errors = countif(toint(resultCode) >= 500)
      | extend rate = iff(total > 0, todouble(errors) / todouble(total), 0.0)
      | where errors >= 5 and rate > 0.01
      | project rate, errors, total
    KQL
    time_aggregation_method = "Count"
    threshold               = 0
    operator                = "GreaterThan"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }

  auto_mitigation_enabled          = true
  workspace_alerts_storage_enabled = false
  skip_query_validation            = true

  tags = local.tags
}

# ─── Alert 2: Function execution failures > 10 in 5min (severity 2) ──────────
#
# Scheduled query because Microsoft.Web/sites `FunctionExecutionCount` does NOT
# expose a `Status` dimension at the metric layer — the only reliable source
# for per-execution success/failure is App Insights `requests.success`.
# Investigate-async severity 2: bursts of single-handler failures aren't
# necessarily user-impacting (could be a misbehaving cron timer or a single
# pathological caller); pair with alert 1 for the user-facing fire signal.

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "function_execution_failures" {
  name                 = "alert-${local.prefix}-function-failures"
  resource_group_name  = azapi_resource.resource_group.name
  location             = azapi_resource.resource_group.location
  evaluation_frequency = "PT5M"
  window_duration      = "PT5M"
  scopes               = [azurerm_application_insights.main.id]
  severity             = 2

  description = "More than 10 Function executions failed in the last 5 minutes (requests where success == false). Triage via docs/runbooks/alerts.md#function-execution-failures."

  criteria {
    query                   = <<-KQL
      requests
      | where timestamp > ago(5m) and success == false
      | summarize failures = count() by bin(timestamp, 5m)
      | where failures > 10
      | project failures
    KQL
    time_aggregation_method = "Count"
    threshold               = 0
    operator                = "GreaterThan"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }

  auto_mitigation_enabled          = true
  workspace_alerts_storage_enabled = false
  skip_query_validation            = true

  tags = local.tags
}

# ─── Alert 3: Storage 503 / throttle > 5/min (severity 1) ────────────────────
#
# Metric alert on the storage account `Transactions` metric, dimensioned by
# `ResponseType` to capture both throttling (ServerBusyError = HTTP 503) and
# generic server-side failures (ServerOtherError). The data plane is the
# only persistence layer (no DB) — sustained storage 5xx == site-down.
#
# Severity 1 (page): every storage 5xx burst is a real fire.

resource "azurerm_monitor_metric_alert" "storage_server_errors" {
  name                = "alert-${local.prefix}-storage-server-errors"
  resource_group_name = azapi_resource.resource_group.name
  scopes              = [azapi_resource.storage.id]
  severity            = 1
  frequency           = "PT1M"
  window_size         = "PT5M"
  enabled             = true
  auto_mitigate       = true

  description = "Storage account returned more than 5 server-side errors (503 throttle or generic server error) in a 1-minute window. Triage via docs/runbooks/alerts.md#storage-server-errors."

  criteria {
    metric_namespace = "Microsoft.Storage/storageAccounts"
    metric_name      = "Transactions"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 5

    dimension {
      name     = "ResponseType"
      operator = "Include"
      values   = ["ServerBusyError", "ServerOtherError"]
    }
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  tags = local.tags
}

# ─── Alert 4: Auth lockout spike > 5 in 15min (severity 2) ───────────────────
#
# Scheduled query against App Insights traces. T16 emits
# `[METRIC] auth.lockout.triggered userId=<sha8>` via console.warn whenever a
# user crosses 5 failed login attempts inside the 10-minute window — these
# surface in App Insights as rows in the `traces` table (NOT customEvents;
# we did not wire trackEvent in T16).
#
# Investigate-async severity 2: 6 lockouts in 15 minutes is anomalous (could
# indicate credential stuffing) but not site-down. Page only if the count
# escalates further or correlates with the 5xx alert.

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "auth_lockout_spike" {
  name                 = "alert-${local.prefix}-auth-lockout-spike"
  resource_group_name  = azapi_resource.resource_group.name
  location             = azapi_resource.resource_group.location
  evaluation_frequency = "PT5M"
  window_duration      = "PT15M"
  scopes               = [azurerm_application_insights.main.id]
  severity             = 2

  description = "More than 5 distinct user lockouts triggered in the last 15 minutes — possible credential stuffing or password reset incident. Triage via docs/runbooks/alerts.md#auth-lockout-spike."

  criteria {
    query                   = <<-KQL
      traces
      | where timestamp > ago(15m)
      | where message has "[METRIC] auth.lockout.triggered"
      | summarize lockouts = count()
      | where lockouts > 5
      | project lockouts
    KQL
    time_aggregation_method = "Count"
    threshold               = 0
    operator                = "GreaterThan"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }

  auto_mitigation_enabled          = true
  workspace_alerts_storage_enabled = false
  skip_query_validation            = true

  tags = local.tags
}

# ─── Alert 5: PDF / lockRound duration p95 > 30s (severity 2) ────────────────
#
# Scheduled query against App Insights requests. `lockRound` is the slowest
# orchestration in the API: it acquires a lease, recomputes brief artifacts,
# generates a PDF, optionally creates PureTrack groups, and emails the brief.
# A sustained p95 above 30s usually means PDF generation is degrading (memory
# pressure on Y1 SKU) or PureTrack upstream is slow.
#
# Investigate-async severity 2: slow lockRound is annoying but not user-facing
# — pilots can still register and view rounds while it degrades.

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "lockround_p95_duration" {
  name                 = "alert-${local.prefix}-lockround-p95"
  resource_group_name  = azapi_resource.resource_group.name
  location             = azapi_resource.resource_group.location
  evaluation_frequency = "PT15M"
  window_duration      = "PT30M"
  scopes               = [azurerm_application_insights.main.id]
  severity             = 2

  description = "lockRound request duration p95 exceeded 30s over 30 minutes — PDF generation or PureTrack call regression. Triage via docs/runbooks/alerts.md#lockround-p95-duration."

  criteria {
    query                   = <<-KQL
      requests
      | where timestamp > ago(30m)
      | where name == "lockRound" or operation_Name == "lockRound"
      | summarize p95_ms = percentile(duration, 95), n = count()
      | where n >= 3 and p95_ms > 30000
      | project p95_ms, n
    KQL
    time_aggregation_method = "Count"
    threshold               = 0
    operator                = "GreaterThan"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }

  auto_mitigation_enabled          = true
  workspace_alerts_storage_enabled = false
  skip_query_validation            = true

  tags = local.tags
}

# ─── Alert 6: Recompute marker stale > 5min (severity 2) ─────────────────────
#
# Scheduled query against App Insights traces for a forward-looking
# `[METRIC] recompute.marker.stale` warning. The emitter is intentionally
# log-based rather than running a separate probe Function — the per-recompute
# code (or a future scheduled probe) is expected to log this trace when it
# observes a season recompute marker older than its SLO. Until the emitter
# ships this alert will never fire; that is the intended default state.
#
# Investigate-async severity 2: stale league recompute affects only the
# public league JSON and is correctable by re-running the recompute path.

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "recompute_marker_stale" {
  name                 = "alert-${local.prefix}-recompute-stale"
  resource_group_name  = azapi_resource.resource_group.name
  location             = azapi_resource.resource_group.location
  evaluation_frequency = "PT5M"
  window_duration      = "PT15M"
  scopes               = [azurerm_application_insights.main.id]
  severity             = 2

  description = "Recompute marker has been stale for more than 5 minutes (any season). Triage via docs/runbooks/alerts.md#recompute-marker-stale."

  criteria {
    query                   = <<-KQL
      traces
      | where timestamp > ago(15m)
      | where message has "[METRIC] recompute.marker.stale"
      | summarize stale_events = count()
      | where stale_events > 0
      | project stale_events
    KQL
    time_aggregation_method = "Count"
    threshold               = 0
    operator                = "GreaterThan"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }

  auto_mitigation_enabled          = true
  workspace_alerts_storage_enabled = false
  skip_query_validation            = true

  tags = local.tags
}
