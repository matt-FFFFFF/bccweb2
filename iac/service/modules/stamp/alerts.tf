# ─── Monitor Action Group ────────────────────────────────────────────────────
#
# Single action group fans out every alert rule below to the on-call email and,
# optionally, a Slack-compatible incoming webhook. No alert in this file uses
# any other action group — operators have ONE place to update routing.
#
# groupShortName is capped at 12 chars by the Azure API; it appears as the SMS /
# voice prefix and must be human-recognisable.

resource "azapi_resource" "ops" {
  type      = "Microsoft.Insights/actionGroups@2024-10-01-preview"
  name      = "ag-bccweb-${var.stamp_name}-ops"
  parent_id = local.stamp_rg_id
  location  = "global"
  tags      = var.tags

  body = {
    properties = {
      groupShortName = "bccops"
      enabled        = true
      emailReceivers = [
        {
          name                 = "ops-email"
          emailAddress         = var.ops_email
          useCommonAlertSchema = true
        }
      ]
      webhookReceivers = var.slack_webhook_url != "" ? [
        {
          name                 = "slack"
          serviceUri           = var.slack_webhook_url
          useCommonAlertSchema = true
        }
      ] : []
    }
  }
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

resource "azapi_resource" "api_5xx_rate" {
  type      = "Microsoft.Insights/scheduledQueryRules@2026-03-01"
  name      = "alert-bccweb-${var.stamp_name}-api-5xx-rate"
  parent_id = local.stamp_rg_id
  location  = var.location
  tags      = var.tags

  body = {
    kind = "LogAlert"
    properties = {
      description                           = "Function App HTTP 5xx error rate exceeded 1% over 5 minutes (with absolute floor of 5 errors). Triage via docs/runbooks/alerts.md#api-5xx-rate."
      enabled                               = true
      evaluationFrequency                   = "PT5M"
      windowSize                            = "PT5M"
      scopes                                = [var.app_insights_id]
      severity                              = 1
      autoMitigate                          = true
      checkWorkspaceAlertsStorageConfigured = false
      skipQueryValidation                   = true
      criteria = {
        allOf = [
          {
            query           = <<-KQL
      requests
      | where timestamp > ago(5m)
      | summarize total = count(), errors = countif(toint(resultCode) >= 500)
      | extend rate = iff(total > 0, todouble(errors) / todouble(total), 0.0)
      | where errors >= 5 and rate > 0.01
      | project rate, errors, total
            KQL
            timeAggregation = "Count"
            dimensions      = []
            operator        = "GreaterThan"
            threshold       = 0
            failingPeriods = {
              minFailingPeriodsToAlert  = 1
              numberOfEvaluationPeriods = 1
            }
          }
        ]
      }
      actions = {
        actionGroups = [azapi_resource.ops.id]
      }
    }
  }
}

# ─── Alert 2: Function execution failures > 10 in 5min (severity 2) ──────────
#
# Scheduled query because Microsoft.Web/sites `FunctionExecutionCount` does NOT
# expose a `Status` dimension at the metric layer — the only reliable source
# for per-execution success/failure is App Insights `requests.success`.
# Investigate-async severity 2: bursts of single-handler failures aren't
# necessarily user-impacting (could be a misbehaving cron timer or a single
# pathological caller); pair with alert 1 for the user-facing fire signal.

resource "azapi_resource" "function_execution_failures" {
  type      = "Microsoft.Insights/scheduledQueryRules@2026-03-01"
  name      = "alert-bccweb-${var.stamp_name}-function-failures"
  parent_id = local.stamp_rg_id
  location  = var.location
  tags      = var.tags

  body = {
    kind = "LogAlert"
    properties = {
      description                           = "More than 10 Function executions failed in the last 5 minutes (requests where success == false). Triage via docs/runbooks/alerts.md#function-execution-failures."
      enabled                               = true
      evaluationFrequency                   = "PT5M"
      windowSize                            = "PT5M"
      scopes                                = [var.app_insights_id]
      severity                              = 2
      autoMitigate                          = true
      checkWorkspaceAlertsStorageConfigured = false
      skipQueryValidation                   = true
      criteria = {
        allOf = [
          {
            query           = <<-KQL
      requests
      | where timestamp > ago(5m) and success == false
      | summarize failures = count() by bin(timestamp, 5m)
      | where failures > 10
      | project failures
            KQL
            timeAggregation = "Count"
            dimensions      = []
            operator        = "GreaterThan"
            threshold       = 0
            failingPeriods = {
              minFailingPeriodsToAlert  = 1
              numberOfEvaluationPeriods = 1
            }
          }
        ]
      }
      actions = {
        actionGroups = [azapi_resource.ops.id]
      }
    }
  }
}

# ─── Alert 3: Storage 503 / throttle > 5/min (severity 1) ────────────────────
#
# Metric alert on the storage account `Transactions` metric, dimensioned by
# `ResponseType` to capture both throttling (ServerBusyError = HTTP 503) and
# generic server-side failures (ServerOtherError). The data plane is the
# only persistence layer (no DB) — sustained storage 5xx == site-down.
#
# Severity 1 (page): every storage 5xx burst is a real fire.

resource "azapi_resource" "storage_server_errors" {
  type      = "Microsoft.Insights/metricAlerts@2018-03-01"
  name      = "alert-bccweb-${var.stamp_name}-storage-server-errors"
  parent_id = local.stamp_rg_id
  location  = "global"
  tags      = var.tags

  body = {
    properties = {
      description         = "Storage account returned more than 5 server-side errors (503 throttle or generic server error) in a 1-minute window. Triage via docs/runbooks/alerts.md#storage-server-errors."
      enabled             = true
      autoMitigate        = true
      scopes              = [azapi_resource.storage.id]
      severity            = 1
      evaluationFrequency = "PT1M"
      windowSize          = "PT5M"
      criteria = {
        "odata.type" = "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria"
        allOf = [
          {
            name            = "StorageServerErrors"
            metricNamespace = "Microsoft.Storage/storageAccounts"
            metricName      = "Transactions"
            timeAggregation = "Total"
            operator        = "GreaterThan"
            threshold       = 5
            criterionType   = "StaticThresholdCriterion"
            dimensions = [
              {
                name     = "ResponseType"
                operator = "Include"
                values   = ["ServerBusyError", "ServerOtherError"]
              }
            ]
          }
        ]
      }
      actions = [
        {
          actionGroupId = azapi_resource.ops.id
        }
      ]
    }
  }
}

# ─── Alert 4: Auth lockout spike > 5 in 15min (severity 2) ───────────────────
#
# Scheduled query against App Insights traces. apps/api/src/lib/rateLimit.ts
# emits `[METRIC] auth.lockout.triggered userId=<sha8>` via console.warn
# whenever a user crosses 5 failed login attempts inside the 10-minute window —
# these surface in App Insights as rows in the `traces` table (NOT customEvents;
# trackEvent is not wired in apps/api/src/lib/rateLimit.ts).
#
# Investigate-async severity 2: 6 lockouts in 15 minutes is anomalous (could
# indicate credential stuffing) but not site-down. Page only if the count
# escalates further or correlates with the 5xx alert.

resource "azapi_resource" "auth_lockout_spike" {
  type      = "Microsoft.Insights/scheduledQueryRules@2026-03-01"
  name      = "alert-bccweb-${var.stamp_name}-auth-lockout-spike"
  parent_id = local.stamp_rg_id
  location  = var.location
  tags      = var.tags

  body = {
    kind = "LogAlert"
    properties = {
      description                           = "More than 5 distinct user lockouts triggered in the last 15 minutes — possible credential stuffing or password reset incident. Triage via docs/runbooks/alerts.md#auth-lockout-spike."
      enabled                               = true
      evaluationFrequency                   = "PT5M"
      windowSize                            = "PT15M"
      scopes                                = [var.app_insights_id]
      severity                              = 2
      autoMitigate                          = true
      checkWorkspaceAlertsStorageConfigured = false
      skipQueryValidation                   = true
      criteria = {
        allOf = [
          {
            query           = <<-KQL
      traces
      | where timestamp > ago(15m)
      | where message has "[METRIC] auth.lockout.triggered"
      | summarize lockouts = count()
      | where lockouts > 5
      | project lockouts
            KQL
            timeAggregation = "Count"
            dimensions      = []
            operator        = "GreaterThan"
            threshold       = 0
            failingPeriods = {
              minFailingPeriodsToAlert  = 1
              numberOfEvaluationPeriods = 1
            }
          }
        ]
      }
      actions = {
        actionGroups = [azapi_resource.ops.id]
      }
    }
  }
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

resource "azapi_resource" "lockround_p95_duration" {
  type      = "Microsoft.Insights/scheduledQueryRules@2026-03-01"
  name      = "alert-bccweb-${var.stamp_name}-lockround-p95"
  parent_id = local.stamp_rg_id
  location  = var.location
  tags      = var.tags

  body = {
    kind = "LogAlert"
    properties = {
      description                           = "lockRound request duration p95 exceeded 30s over 30 minutes — PDF generation or PureTrack call regression. Triage via docs/runbooks/alerts.md#lockround-p95-duration."
      enabled                               = true
      evaluationFrequency                   = "PT15M"
      windowSize                            = "PT30M"
      scopes                                = [var.app_insights_id]
      severity                              = 2
      autoMitigate                          = true
      checkWorkspaceAlertsStorageConfigured = false
      skipQueryValidation                   = true
      criteria = {
        allOf = [
          {
            query           = <<-KQL
      requests
      | where timestamp > ago(30m)
      | where name == "lockRound" or operation_Name == "lockRound"
      | summarize p95_ms = percentile(duration, 95), n = count()
      | where n >= 3 and p95_ms > 30000
      | project p95_ms, n
            KQL
            timeAggregation = "Count"
            dimensions      = []
            operator        = "GreaterThan"
            threshold       = 0
            failingPeriods = {
              minFailingPeriodsToAlert  = 1
              numberOfEvaluationPeriods = 1
            }
          }
        ]
      }
      actions = {
        actionGroups = [azapi_resource.ops.id]
      }
    }
  }
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

resource "azapi_resource" "recompute_marker_stale" {
  type      = "Microsoft.Insights/scheduledQueryRules@2026-03-01"
  name      = "alert-bccweb-${var.stamp_name}-recompute-stale"
  parent_id = local.stamp_rg_id
  location  = var.location
  tags      = var.tags

  body = {
    kind = "LogAlert"
    properties = {
      description                           = "Recompute marker has been stale for more than 5 minutes (any season). Triage via docs/runbooks/alerts.md#recompute-marker-stale."
      enabled                               = true
      evaluationFrequency                   = "PT5M"
      windowSize                            = "PT15M"
      scopes                                = [var.app_insights_id]
      severity                              = 2
      autoMitigate                          = true
      checkWorkspaceAlertsStorageConfigured = false
      skipQueryValidation                   = true
      criteria = {
        allOf = [
          {
            query           = <<-KQL
      traces
      | where timestamp > ago(15m)
      | where message has "[METRIC] recompute.marker.stale"
      | summarize stale_events = count()
      | where stale_events > 0
      | project stale_events
            KQL
            timeAggregation = "Count"
            dimensions      = []
            operator        = "GreaterThan"
            threshold       = 0
            failingPeriods = {
              minFailingPeriodsToAlert  = 1
              numberOfEvaluationPeriods = 1
            }
          }
        ]
      }
      actions = {
        actionGroups = [azapi_resource.ops.id]
      }
    }
  }
}
