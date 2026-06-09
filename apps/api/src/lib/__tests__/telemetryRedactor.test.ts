import { describe, it, expect } from "vitest";
import {
  PiiRedactingTelemetryProcessor,
  PII_FIELDS,
  redactObject,
  type TelemetryEnvelope,
} from "../telemetryRedactor.js";

// ─── redactObject unit tests ──────────────────────────────────────────────────

describe("redactObject", () => {
  it("replaces every PII field value with '***'", () => {
    const input = {
      email: "pilot@example.com",
      password: "s3cr3t",
      phoneNumber: "+447700900000",
      medicalInfo: "none",
      name: "Alice",
    };
    const result = redactObject(input) as Record<string, unknown>;
    expect(result["email"]).toBe("***");
    expect(result["password"]).toBe("***");
    expect(result["phoneNumber"]).toBe("***");
    expect(result["medicalInfo"]).toBe("***");
    // Non-PII field untouched
    expect(result["name"]).toBe("Alice");
  });

  it("leaves non-PII fields untouched at every depth", () => {
    const input = {
      id: "abc-123",
      seasonYear: 2024,
      club: { id: "club-1", name: "Acme" },
      score: 42,
    };
    const result = redactObject(input) as Record<string, unknown>;
    expect(result["id"]).toBe("abc-123");
    expect(result["seasonYear"]).toBe(2024);
    expect((result["club"] as Record<string, unknown>)["name"]).toBe("Acme");
    expect(result["score"]).toBe(42);
  });

  it("handles deeply-nested objects", () => {
    const input = {
      pilot: {
        person: {
          phoneNumber: "+447700900001",
        },
        medicalInfo: "asthma",
        wing: {
          model: "Ozone Rush 6",
          wingColours: "blue/white",
        },
      },
    };
    const result = redactObject(input) as {
      pilot: {
        person: Record<string, unknown>;
        medicalInfo: unknown;
        wing: Record<string, unknown>;
      };
    };
    expect(result.pilot.person["phoneNumber"]).toBe("***");
    expect(result.pilot.medicalInfo).toBe("***");
    expect(result.pilot.wing["wingColours"]).toBe("***");
    // Non-PII sub-field
    expect(result.pilot.wing["model"]).toBe("Ozone Rush 6");
  });

  it("handles arrays of objects", () => {
    const input = [
      { id: "p1", email: "a@b.com", name: "Alice" },
      { id: "p2", email: "c@d.com", name: "Bob" },
    ];
    const result = redactObject(input) as Array<Record<string, unknown>>;
    expect(result[0]["email"]).toBe("***");
    expect(result[0]["name"]).toBe("Alice");
    expect(result[1]["email"]).toBe("***");
    expect(result[1]["name"]).toBe("Bob");
  });

  it("handles nested arrays", () => {
    const input = {
      pilots: [
        { id: "p1", emergencyContactName: "John", score: 10 },
        { id: "p2", emergencyContactName: "Jane", score: 20 },
      ],
    };
    const result = redactObject(input) as {
      pilots: Array<Record<string, unknown>>;
    };
    expect(result.pilots[0]["emergencyContactName"]).toBe("***");
    expect(result.pilots[0]["score"]).toBe(10);
    expect(result.pilots[1]["emergencyContactName"]).toBe("***");
  });

  it("does not mutate the input object", () => {
    const input = { email: "orig@test.com", name: "Orig" };
    redactObject(input);
    expect(input.email).toBe("orig@test.com");
  });

  it("handles null and primitive inputs safely", () => {
    expect(redactObject(null)).toBeNull();
    expect(redactObject(42)).toBe(42);
    expect(redactObject("hello")).toBe("hello");
    expect(redactObject(undefined)).toBeUndefined();
  });

  it("accepts a custom field list override", () => {
    const input = { secret: "hidden", email: "visible@test.com" };
    const result = redactObject(input, ["secret"]) as Record<string, unknown>;
    expect(result["secret"]).toBe("***");
    // email is NOT in the custom list so it passes through
    expect(result["email"]).toBe("visible@test.com");
  });
});

// ─── PiiRedactingTelemetryProcessor tests ─────────────────────────────────────

describe("PiiRedactingTelemetryProcessor", () => {
  it("exports PII_FIELDS with the canonical field set", () => {
    const required = [
      "email",
      "password",
      "phoneNumber",
      "bhpaNumber",
      "medicalInfo",
      "emergencyContactName",
      "emergencyPhoneNumber",
      "accessToken",
      "refreshToken",
      "ip",
      "userAgent",
      "wingColours",
    ];
    for (const field of required) {
      expect(PII_FIELDS).toContain(field);
    }
  });

  it("scrubs every PII field from a fake App Insights envelope", () => {
    const processor = new PiiRedactingTelemetryProcessor();
    const envelope: TelemetryEnvelope = {
      name: "Microsoft.ApplicationInsights.Event",
      data: {
        baseType: "EventData",
        baseData: {
          name: "pilot.registered",
          properties: {
            pilotId: "uuid-123",
            email: "pilot@example.com",
            phoneNumber: "+447700900000",
          },
          customDimensions: {
            medicalInfo: "none",
            emergencyContactName: "Bob",
            roundId: "round-abc",
          },
        },
      },
    };

    const forwarded = processor.process(envelope);
    expect(forwarded).toBe(true);

    const baseData = envelope.data!.baseData!;
    const props = baseData["properties"] as Record<string, unknown>;
    expect(props["email"]).toBe("***");
    expect(props["phoneNumber"]).toBe("***");
    expect(props["pilotId"]).toBe("uuid-123"); // non-PII preserved

    const dims = baseData["customDimensions"] as Record<string, unknown>;
    expect(dims["medicalInfo"]).toBe("***");
    expect(dims["emergencyContactName"]).toBe("***");
    expect(dims["roundId"]).toBe("round-abc"); // non-PII preserved
  });

  it("leaves non-PII fields untouched in the envelope", () => {
    const processor = new PiiRedactingTelemetryProcessor();
    const envelope: TelemetryEnvelope = {
      name: "Microsoft.ApplicationInsights.PageView",
      iKey: "instrumentation-key",
      data: {
        baseData: {
          url: "https://app.bcc.example/rounds",
          duration: 123,
          name: "RoundsList",
        },
      },
    };

    processor.process(envelope);

    const baseData = envelope.data!.baseData!;
    expect(baseData["url"]).toBe("https://app.bcc.example/rounds");
    expect(baseData["duration"]).toBe(123);
    expect(baseData["name"]).toBe("RoundsList");
    expect(envelope["iKey"]).toBe("instrumentation-key");
  });

  it("handles deeply-nested objects and arrays in baseData", () => {
    const processor = new PiiRedactingTelemetryProcessor();
    const envelope: TelemetryEnvelope = {
      data: {
        baseData: {
          slots: [
            { pilotId: "p1", phoneNumber: "+447700900000", score: 10 },
            { pilotId: "p2", medicalInfo: "asthma", score: 20 },
          ],
          nested: {
            deep: {
              accessToken: "tok_abc",
              roundId: "round-1",
            },
          },
        },
      },
    };

    processor.process(envelope);

    const slots = (
      envelope.data!.baseData!["slots"] as Array<Record<string, unknown>>
    );
    expect(slots[0]["phoneNumber"]).toBe("***");
    expect(slots[0]["score"]).toBe(10);
    expect(slots[1]["medicalInfo"]).toBe("***");
    expect(slots[1]["score"]).toBe(20);

    const deep = (
      envelope.data!.baseData!["nested"] as Record<string, unknown>
    )["deep"] as Record<string, unknown>;
    expect(deep["accessToken"]).toBe("***");
    expect(deep["roundId"]).toBe("round-1");
  });

  it("handles envelope with no data gracefully", () => {
    const processor = new PiiRedactingTelemetryProcessor();
    const envelope: TelemetryEnvelope = { name: "bare" };
    expect(() => processor.process(envelope)).not.toThrow();
    expect(processor.process(envelope)).toBe(true);
  });

  it("handles null envelope gracefully", () => {
    const processor = new PiiRedactingTelemetryProcessor();
    // SDK may pass null in edge cases
    expect(processor.process(null as unknown as TelemetryEnvelope)).toBe(true);
  });

  it("accepts a custom field list in the constructor", () => {
    const processor = new PiiRedactingTelemetryProcessor(["secret"]);
    const envelope: TelemetryEnvelope = {
      data: {
        baseData: {
          secret: "hidden",
          email: "visible@test.com",
        },
      },
    };
    processor.process(envelope);
    expect(envelope.data!.baseData!["secret"]).toBe("***");
    // email is not in the custom list — passes through
    expect(envelope.data!.baseData!["email"]).toBe("visible@test.com");
  });

  it("process method can be passed as a standalone callback (bound correctly)", () => {
    const processor = new PiiRedactingTelemetryProcessor();
    const { process } = processor; // destructure — this would break if not bound
    const envelope: TelemetryEnvelope = {
      data: { baseData: { email: "x@y.com" } },
    };
    const result = process(envelope);
    expect(result).toBe(true);
    expect(envelope.data!.baseData!["email"]).toBe("***");
  });
});
