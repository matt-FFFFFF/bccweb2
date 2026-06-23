import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as appInsights from "applicationinsights";
import { setup, getTelemetryClient, resetForTests } from "../telemetry.js";
import { PII_FIELDS, PiiRedactingLogRecordProcessor } from "../telemetryRedactor.js";

const CONN =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.invalid/";

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

  it("initialises the SDK and registers exactly one telemetry processor when configured", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] = CONN;

    setup();

    const client = getTelemetryClient();
    expect(client).toBeDefined();
    expect(client).toBe(appInsights.defaultClient);

    // applicationinsights v3 is OTel-native; addTelemetryProcessor is a no-op
    // shim. PII redaction is wired via setAzureMonitorOptions logRecordProcessors.
    // The parsed options are stored on the client's private _options field; assert
    // exactly one PiiRedactingLogRecordProcessor is present.
    const processors = (
      client as unknown as { _options: { logRecordProcessors: unknown[] } }
    )._options.logRecordProcessors;
    const piiProcessors = (processors ?? []).filter(
      (p) => p instanceof PiiRedactingLogRecordProcessor
    );
    expect(piiProcessors).toHaveLength(1);
  });

  it("is idempotent — calling setup() twice does not double-register the processor", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] = CONN;

    setup();
    setup();

    const client = getTelemetryClient()!;
    const processors = (
      client as unknown as { _options: { logRecordProcessors: unknown[] } }
    )._options.logRecordProcessors ?? [];
    const piiProcessors = processors.filter(
      (p) => p instanceof PiiRedactingLogRecordProcessor
    );
    expect(piiProcessors).toHaveLength(1);
  });

  it("scrubs PII from a fired track event before it reaches the channel", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] = CONN;

    setup();
    const client = getTelemetryClient()!;

    // In applicationinsights v3 (OTel-native), trackEvent() maps
    // telemetry.properties into OTel log-record attributes. PII is scrubbed by
    // PiiRedactingLogRecordProcessor.onEmit() before the record is exported.
    //
    // Verify by retrieving the registered processor from the client options and
    // calling onEmit() with a mock log record whose attributes mirror what the
    // SDK would produce from trackEvent({ properties: { ... } }).
    const processors = (
      client as unknown as { _options: { logRecordProcessors: unknown[] } }
    )._options.logRecordProcessors ?? [];
    const piiProcessor = processors.find(
      (p) => p instanceof PiiRedactingLogRecordProcessor
    ) as PiiRedactingLogRecordProcessor | undefined;
    if (!piiProcessor) {
      throw new Error("PiiRedactingLogRecordProcessor not registered in client._options.logRecordProcessors");
    }

    const attrs: Record<string, unknown> = {
      pilotId: "uuid-123",
      email: "pilot@example.com",
      phoneNumber: "+447700900000",
      medicalInfo: "asthma",
      accessToken: "tok_secret",
      roundId: "round-abc",
    };
    const mockRecord = {
      attributes: attrs,
      setAttribute(key: string, value: unknown) {
        attrs[key] = value;
        return this;
      },
    };

    piiProcessor.onEmit(mockRecord);

    expect(attrs["email"]).toBe("***");
    expect(attrs["phoneNumber"]).toBe("***");
    expect(attrs["medicalInfo"]).toBe("***");
    expect(attrs["accessToken"]).toBe("***");
    expect(attrs["pilotId"]).toBe("uuid-123");
    expect(attrs["roundId"]).toBe("round-abc");

    // Verify the canonical PII field list covers what we tested above.
    for (const field of ["email", "phoneNumber", "medicalInfo", "accessToken"]) {
      expect(PII_FIELDS).toContain(field);
    }
    // None of the raw PII values appear in a JSON dump of the scrubbed attrs.
    const serialised = JSON.stringify(attrs);
    expect(serialised).not.toContain("pilot@example.com");
    expect(serialised).not.toContain("+447700900000");
    expect(serialised).not.toContain("tok_secret");
    expect(serialised).not.toContain("asthma");
  });
});
