import * as appInsights from "applicationinsights";
import {
  HealthFilterTelemetryProcessor,
  PiiRedactingTelemetryProcessor,
  type TelemetryEnvelope,
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
    .start();

  const client = appInsights.defaultClient;
  if (client) {
    const healthFilter = new HealthFilterTelemetryProcessor();
    client.addTelemetryProcessor(
      (envelope, contextObjects) =>
        healthFilter.process(
          envelope as unknown as TelemetryEnvelope,
          contextObjects as Record<string, unknown> | undefined
        )
    );

    const processor = new PiiRedactingTelemetryProcessor();
    client.addTelemetryProcessor(
      (envelope, contextObjects) =>
        processor.process(
          envelope as unknown as TelemetryEnvelope,
          contextObjects as Record<string, unknown> | undefined
        )
    );
  }

  initialised = true;
  console.info("[telemetry] Application Insights initialised with health filter and PII redactor");
}

export function getTelemetryClient(): appInsights.TelemetryClient | undefined {
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
