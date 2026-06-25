import appInsights from "applicationinsights";
import type * as appInsightsTypes from "applicationinsights";
import {
  PiiRedactingLogRecordProcessor,
  PiiRedactingSpanProcessor,
} from "./telemetryRedactor.js";

let initialised = false;

function readConnectionString(): string | undefined {
  const value = process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function setup(): void {
  if (initialised) return;

  const connectionString = readConnectionString();

  if (!connectionString) {
    console.warn(
      "[telemetry] APPLICATIONINSIGHTS_CONNECTION_STRING not set — telemetry disabled (local-dev mode)"
    );
    initialised = true;
    return;
  }

  appInsights
    .setup(connectionString)
    .setAutoCollectRequests(true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectPerformance(true, true)
    .setSendLiveMetrics(false)
    .setAzureMonitorOptions({
      spanProcessors: [new PiiRedactingSpanProcessor()],
      logRecordProcessors: [new PiiRedactingLogRecordProcessor()],
    })
    .start();

  initialised = true;
  console.info(
    "[telemetry] Application Insights initialised with v3 span/log PII processors"
  );
}

export function getTelemetryClient(): appInsightsTypes.TelemetryClient | undefined {
  return appInsights.defaultClient ?? undefined;
}

export function resetForTests(): void {
  initialised = false;
  try {
    appInsights.dispose();
  } catch {
    // dispose throws if not initialised — safe to ignore in test teardown
  }
}
