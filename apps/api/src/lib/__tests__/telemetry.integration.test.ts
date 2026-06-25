import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as appInsights from "applicationinsights";
import { setup, getTelemetryClient, resetForTests } from "../telemetry.js";
import {
  PiiRedactingLogRecordProcessor,
  PiiRedactingSpanProcessor,
} from "../telemetryRedactor.js";

const CONN =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.invalid/";

type MutableSpanContext = ReturnType<ReadableSpan["spanContext"]>;

function createIntegrationSpan(attributes: Record<string, unknown>): ReadableSpan {
  const context: MutableSpanContext = {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: TraceFlags.SAMPLED,
  };

  return {
    name: "Functions.rounds",
    kind: SpanKind.SERVER,
    spanContext: () => context,
    startTime: [0, 0],
    endTime: [0, 1],
    status: { code: SpanStatusCode.UNSET },
    attributes,
    links: [],
    events: [],
    duration: [0, 1],
    ended: true,
    resource: {} as ReadableSpan["resource"],
    instrumentationScope: { name: "integration-test" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function createIntegrationLogRecord(): {
  readonly logRecord: SdkLogRecord;
  readonly setAttribute: ReturnType<typeof vi.fn>;
} {
  const setAttribute = vi.fn((_key: string, _value?: unknown) => logRecord);
  const logRecord = {
    hrTime: [0, 0],
    hrTimeObserved: [0, 0],
    resource: {} as SdkLogRecord["resource"],
    instrumentationScope: { name: "integration-test" },
    attributes: { email: "pilot@example.com", accessToken: "tok_secret" },
    droppedAttributesCount: 0,
    setAttribute,
    setAttributes: vi.fn(() => logRecord),
    setBody: vi.fn(() => logRecord),
    setEventName: vi.fn(() => logRecord),
    setSeverityNumber: vi.fn(() => logRecord),
    setSeverityText: vi.fn(() => logRecord),
  } satisfies SdkLogRecord;

  return { logRecord, setAttribute };
}

describe("telemetry.setup()", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"];

  beforeEach(() => {
    resetForTests();
    delete process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"];
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetForTests();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    if (originalEnv === undefined) {
      delete process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"];
    } else {
      process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] = originalEnv;
    }
  });

  it("no-ops without throwing and logs a warning when the connection string is absent", () => {
    expect(() => setup()).not.toThrow();
    expect(getTelemetryClient()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("APPLICATIONINSIGHTS_CONNECTION_STRING not set");
    expect(msg).toContain("local-dev");
  });

  it("treats an empty/whitespace-only connection string as absent (no throw, no init)", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] = "   ";
    expect(() => setup()).not.toThrow();
    expect(getTelemetryClient()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("initialises the SDK when configured", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] = CONN;

    setup();

    const client = getTelemetryClient();
    // Vitest's module runner gives live CJS namespace bindings, while native
    // Node ESM does not. The production-parity guard is the compiled-dist
    // native ESM probe recorded in fix-getclient-probe.txt.
    expect(client).toBeDefined();
    expect(client).toBe(appInsights.defaultClient);
    expect(infoSpy).toHaveBeenCalledWith(
      "[telemetry] Application Insights initialised with v3 span/log PII processors"
    );
  });

  it("is idempotent — calling setup() twice keeps the same client", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] = CONN;

    setup();
    const firstClient = getTelemetryClient();
    setup();

    const secondClient = getTelemetryClient();
    expect(firstClient).toBeDefined();
    expect(secondClient).toBe(firstClient);
    expect(secondClient).toBe(appInsights.defaultClient);
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it("scrubs PII through the v3 span and log processors used by setup", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] = CONN;

    setup();
    expect(getTelemetryClient()).toBeDefined();

    const spanAttributes: Record<string, unknown> = {
      email: "pilot@example.com",
      "url.query": "token=tok_secret",
      "http.method": "GET",
    };
    const span = createIntegrationSpan(spanAttributes);
    new PiiRedactingSpanProcessor().onEnd(span);

    const { logRecord, setAttribute } = createIntegrationLogRecord();
    new PiiRedactingLogRecordProcessor().onEmit(logRecord);

    expect(spanAttributes["email"]).toBe("***");
    expect(spanAttributes["url.query"]).toBe("***");
    expect(spanAttributes["http.method"]).toBe("GET");
    expect(span.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
    expect(setAttribute).toHaveBeenCalledWith("email", "***");
    expect(setAttribute).toHaveBeenCalledWith("accessToken", "***");
  });
});
