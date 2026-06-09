import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as appInsights from "applicationinsights";
import { setup, getTelemetryClient, resetForTests } from "../telemetry.js";
import { PII_FIELDS } from "../telemetryRedactor.js";

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

    // applicationinsights v2 keeps the registered processors on the
    // TelemetryClient itself (private `_telemetryProcessors` array); v3
    // moved this to a no-op shim. We pinned v2 in apps/api/package.json
    // precisely so the redactor actually runs — assert exactly one is
    // present (the PiiRedactingTelemetryProcessor's bound `process`).
    const processors = (
      client as unknown as { _telemetryProcessors: unknown[] }
    )._telemetryProcessors;
    expect(Array.isArray(processors)).toBe(true);
    expect(processors).toHaveLength(1);
  });

  it("is idempotent — calling setup() twice does not double-register the processor", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] = CONN;

    setup();
    setup();

    const client = getTelemetryClient()!;
    const processors = (
      client as unknown as { _telemetryProcessors: unknown[] }
    )._telemetryProcessors;
    expect(processors).toHaveLength(1);
  });

  it("scrubs PII from a fired track event before it reaches the channel", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] = CONN;

    setup();
    const client = getTelemetryClient()!;

    // Replace the channel sink so envelopes are captured instead of sent.
    // The SDK still runs the full processor pipeline before invoking `send`,
    // which is exactly what we want to verify.
    const captured: Array<Record<string, unknown>> = [];
    (client.channel as unknown as { send: (e: unknown) => void }).send = (
      envelope: unknown
    ) => {
      captured.push(envelope as Record<string, unknown>);
    };

    client.trackEvent({
      name: "pilot.registered",
      properties: {
        pilotId: "uuid-123",
        email: "pilot@example.com",
        phoneNumber: "+447700900000",
        medicalInfo: "asthma",
        accessToken: "tok_secret",
        roundId: "round-abc",
      },
    });

    expect(captured).toHaveLength(1);
    const envelope = captured[0]!;
    const data = envelope["data"] as { baseData?: Record<string, unknown> };
    const baseData = data?.baseData ?? {};
    const props = (baseData["properties"] ?? {}) as Record<string, unknown>;

    expect(props["email"]).toBe("***");
    expect(props["phoneNumber"]).toBe("***");
    expect(props["medicalInfo"]).toBe("***");
    expect(props["accessToken"]).toBe("***");
    expect(props["pilotId"]).toBe("uuid-123");
    expect(props["roundId"]).toBe("round-abc");

    const serialised = JSON.stringify(envelope);
    for (const field of ["email", "phoneNumber", "medicalInfo", "accessToken"]) {
      expect(PII_FIELDS).toContain(field);
    }
    expect(serialised).not.toContain("pilot@example.com");
    expect(serialised).not.toContain("+447700900000");
    expect(serialised).not.toContain("tok_secret");
    expect(serialised).not.toContain("asthma");
  });
});
