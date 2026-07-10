// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { SpanKind, SpanStatusCode, TraceFlags, type Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { SdkLogRecord } from "@opentelemetry/sdk-logs";
import { describe, it, expect, vi } from "vitest";
import {
  OTEL_PII_SPAN_ATTRS,
  PiiRedactingLogRecordProcessor,
  PiiRedactingSpanProcessor,
  PII_FIELDS,
  redactAttributesInPlace,
  redactObject,
} from "../telemetryRedactor.js";

type MutableSpanContext = ReturnType<ReadableSpan["spanContext"]>;

function createMockSpan(
  overrides: {
    readonly name?: string;
    readonly kind?: SpanKind;
    readonly attributes?: Record<string, unknown>;
    readonly statusCode?: SpanStatusCode;
    readonly traceFlags?: number;
  } = {}
): ReadableSpan {
  const context: MutableSpanContext = {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: overrides.traceFlags ?? TraceFlags.SAMPLED,
  };

  return {
    name: overrides.name ?? "Functions.health",
    kind: overrides.kind ?? SpanKind.SERVER,
    spanContext: () => context,
    startTime: [0, 0],
    endTime: [0, 1],
    status: { code: overrides.statusCode ?? SpanStatusCode.UNSET },
    attributes: (overrides.attributes ?? { "http.response.status_code": 200 }) as Attributes,
    links: [],
    events: [],
    duration: [0, 1],
    ended: true,
    resource: {} as ReadableSpan["resource"],
    instrumentationScope: { name: "test" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function createMockLogRecord(attributes: SdkLogRecord["attributes"] = {}): {
  readonly logRecord: SdkLogRecord;
  readonly setAttribute: ReturnType<typeof vi.fn>;
} {
  const setAttribute = vi.fn((_key: string, _value?: unknown) => logRecord);
  const logRecord: SdkLogRecord = {
    hrTime: [0, 0],
    hrTimeObserved: [0, 0],
    resource: {} as SdkLogRecord["resource"],
    instrumentationScope: { name: "test" },
    attributes,
    droppedAttributesCount: 0,
    setAttribute,
    setAttributes: vi.fn(() => logRecord),
    setBody: vi.fn(() => logRecord),
    setEventName: vi.fn(() => logRecord),
    setSeverityNumber: vi.fn(() => logRecord),
    setSeverityText: vi.fn(() => logRecord),
  };

  return { logRecord, setAttribute };
}

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
    const input = {
      email: "orig@test.com",
      name: "Orig",
      nested: { accessToken: "tok_abc", roundId: "round-1" },
    };

    const result = redactObject(input) as Record<string, unknown>;

    expect(input.email).toBe("orig@test.com");
    expect(input.nested.accessToken).toBe("tok_abc");
    expect(result["email"]).toBe("***");
    expect((result["nested"] as Record<string, unknown>)["accessToken"]).toBe(
      "***"
    );
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

describe("OTel attribute redaction primitives", () => {
  it("exports the OTel semantic-convention keys that can carry PII", () => {
    const required = [
      "url.full",
      "url.query",
      "user_agent.original",
      "http.user_agent",
      "client.address",
      "server.address",
      "network.peer.address",
      "net.peer.name",
      "net.sock.peer.addr",
      "http.request.header.authorization",
      "http.request.header.cookie",
    ];

    for (const key of required) {
      expect(OTEL_PII_SPAN_ATTRS).toContain(key);
    }
  });

  it("masks OTel URL, user-agent, and client-address attributes in place", () => {
    const attrs: Record<string, unknown> = {
      "url.query": "token=abc",
      "user_agent.original": "Mozilla/5.0",
      "client.address": "1.2.3.4",
    };

    redactAttributesInPlace(attrs);

    expect(attrs["url.query"]).toBe("***");
    expect(attrs["user_agent.original"]).toBe("***");
    expect(attrs["client.address"]).toBe("***");
  });

  it("leaves non-PII OTel attributes untouched", () => {
    const attrs: Record<string, unknown> = {
      "http.method": "GET",
      "url.path": "/api/rounds",
      "http.response.status_code": 200,
    };

    redactAttributesInPlace(attrs);

    expect(attrs["http.method"]).toBe("GET");
    expect(attrs["url.path"]).toBe("/api/rounds");
    expect(attrs["http.response.status_code"]).toBe(200);
  });

  it("deep-redacts object and array attribute values without mutating originals", () => {
    const customDimensions = {
      email: "pilot@example.com",
      publicId: "pilot-1",
      auth: { accessToken: "tok_abc", scope: "rounds" },
      passengers: [{ email: "passenger@example.com", name: "Passenger" }],
    };
    const attrs: Record<string, unknown> = {
      "bcc.custom_dimensions": customDimensions,
    };

    redactAttributesInPlace(attrs);

    const redacted = attrs["bcc.custom_dimensions"] as Record<string, unknown>;
    expect(redacted["email"]).toBe("***");
    expect(redacted["publicId"]).toBe("pilot-1");
    expect((redacted["auth"] as Record<string, unknown>)["accessToken"]).toBe(
      "***"
    );
    expect(
      ((redacted["passengers"] as Array<Record<string, unknown>>)[0])["email"]
    ).toBe("***");
    expect(customDimensions.email).toBe("pilot@example.com");
    expect(customDimensions.auth.accessToken).toBe("tok_abc");
  });

  it("masks literal PII_FIELD attribute keys and accepts override lists", () => {
    const attrs: Record<string, unknown> = {
      email: "pilot@example.com",
      "otel.secret": "hidden",
      visible: "kept",
    };

    redactAttributesInPlace(attrs, ["email"], ["otel.secret"]);

    expect(attrs["email"]).toBe("***");
    expect(attrs["otel.secret"]).toBe("***");
    expect(attrs["visible"]).toBe("kept");
  });
});

describe("PiiRedactingLogRecordProcessor", () => {
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

  it("redacts only PII attributes already present on emitted log records", () => {
    const processor = new PiiRedactingLogRecordProcessor();
    const { logRecord, setAttribute } = createMockLogRecord({
      email: "pilot@example.com",
      accessToken: "tok_abc",
      roundId: "round-1",
    });

    processor.onEmit(logRecord);

    expect(setAttribute).toHaveBeenCalledWith("email", "***");
    expect(setAttribute).toHaveBeenCalledWith("accessToken", "***");
    expect(setAttribute).not.toHaveBeenCalledWith("password", "***");
    expect(setAttribute).not.toHaveBeenCalledWith("roundId", "***");
    expect(setAttribute).toHaveBeenCalledTimes(2);
  });

  it("resolves forceFlush and shutdown", async () => {
    const processor = new PiiRedactingLogRecordProcessor();

    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });
});

describe("PiiRedactingSpanProcessor", () => {
  it("clears the sampled trace flag for successful Functions.health server spans", () => {
    const processor = new PiiRedactingSpanProcessor();
    const span = createMockSpan();

    processor.onEnd(span);

    expect(span.spanContext().traceFlags).toBe(TraceFlags.NONE);
  });

  it("retains the sampled trace flag for health spans with error status", () => {
    const processor = new PiiRedactingSpanProcessor();
    const span = createMockSpan({ statusCode: SpanStatusCode.ERROR });

    processor.onEnd(span);

    expect(span.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
  });

  it("retains the sampled trace flag for health spans with HTTP status >= 400", () => {
    const processor = new PiiRedactingSpanProcessor();
    const span = createMockSpan({
      attributes: { "http.response.status_code": 503 },
    });

    processor.onEnd(span);
    expect(span.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
  });

  it("leaves non-health spans sampled and redacts PII attributes", () => {
    const processor = new PiiRedactingSpanProcessor();
    const attributes: Record<string, unknown> = {
      email: "pilot@example.com",
      "http.response.status_code": 200,
      "http.method": "GET",
    };
    const span = createMockSpan({ name: "Functions.rounds", attributes });

    processor.onEnd(span);

    expect(span.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
    expect(attributes["email"]).toBe("***");
    expect(attributes["http.method"]).toBe("GET");
  });

  it("redacts OTel URL, user-agent, and network attributes", () => {
    const processor = new PiiRedactingSpanProcessor();
    const attributes: Record<string, unknown> = {
      "url.query": "token=abc",
      "user_agent.original": "Mozilla/5.0",
      "client.address": "203.0.113.42",
      "http.response.status_code": 200,
    };
    const span = createMockSpan({ name: "Functions.rounds", attributes });

    processor.onEnd(span);

    expect(attributes["url.query"]).toBe("***");
    expect(attributes["user_agent.original"]).toBe("***");
    expect(attributes["client.address"]).toBe("***");
  });

  it("treats HTTP server span names containing health as health candidates", () => {
    const processor = new PiiRedactingSpanProcessor();
    const span = createMockSpan({ name: "GET /api/health" });

    processor.onEnd(span);
    expect(span.spanContext().traceFlags).toBe(TraceFlags.NONE);
  });

  it("does not drop client spans whose names contain health", () => {
    const processor = new PiiRedactingSpanProcessor();
    const span = createMockSpan({
      name: "GET https://example.test/health",
      kind: SpanKind.CLIENT,
    });

    processor.onEnd(span);
    expect(span.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
  });

  it("resolves forceFlush and shutdown", async () => {
    const processor = new PiiRedactingSpanProcessor();

    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });
});
