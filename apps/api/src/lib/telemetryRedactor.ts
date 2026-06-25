/**
 * telemetryRedactor.ts
 *
 * OpenTelemetry processors for Application Insights v3 / Azure Monitor.
 *
 * T4 wires PiiRedactingSpanProcessor and PiiRedactingLogRecordProcessor through
 * setAzureMonitorOptions({ spanProcessors, logRecordProcessors }); v3's legacy
 * client.addTelemetryProcessor() shim is not part of the live path.
 *
 * The PII_FIELDS constant is a TS-native copy of the list maintained in
 * scripts/lib/pii.mjs (the two lists MUST be kept in sync).
 */

import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type {
  LogRecordProcessor,
  SdkLogRecord,
} from "@opentelemetry/sdk-logs";

// ─── PII field list (source of truth: scripts/lib/pii.mjs) ───────────────────
//
// Duplicated here to avoid cross-package .mjs import friction from TypeScript.
// When adding or removing a field, update BOTH files.

export const PII_FIELDS: ReadonlyArray<string> = [
  "email",
  "password",
  "passwordHash",
  "phoneNumber",
  "bhpaNumber",
  "medicalInfo",
  "emergencyContactName",
  "emergencyPhoneNumber",
  "userAgent",
  "ip",
  "Authorization",
  "JWT",
  "jwt",
  "accessToken",
  "refreshToken",
  "verifyToken",
  "resetToken",
  "helmetColour",
  "harnessType",
  "harnessColour",
  "wingModel",
  // "wingClass" is intentionally excluded: EN A/B/C/D is a competition scoring
  // category that appears in public results/{year}.json and is required for
  // scoring transparency. Exception approved: Matt White, 2026-06-09.
  // See docs/runbooks/privacy.md — Exceptions table.
  "wingColours",
];

// OTel HTTP/Functions instrumentation records the same PII concepts under
// semantic-convention attribute keys rather than this app's PII_FIELDS names:
// - url.full, url.query → url-style request data; query strings can carry tokens/PII.
// - user_agent.original, http.user_agent → userAgent.
// - client.address → ip/client network address.
// - server.address, network.peer.address, net.peer.name, net.sock.peer.addr →
//   network identifiers/IP-like peer addresses.
// - http.request.header.authorization, http.request.header.cookie → auth/token headers.
export const OTEL_PII_SPAN_ATTRS: ReadonlyArray<string> = [
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

const DEFAULT_PII_FIELD_SET: ReadonlySet<string> = new Set(PII_FIELDS);
const DEFAULT_OTEL_PII_SPAN_ATTR_SET: ReadonlySet<string> = new Set(
  OTEL_PII_SPAN_ATTRS
);

// ─── Redaction helpers ────────────────────────────────────────────────────────

/**
 * Deep-clone a value, replacing every PII field value with "***".
 * Mutates nothing; always returns a new object tree.
 */
export function redactObject(
  obj: unknown,
  fields: ReadonlyArray<string> = PII_FIELDS
): unknown {
  if (obj === null || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, fields));
  }

  const record = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (fields.includes(key)) {
      result[key] = "***";
    } else if (value !== null && typeof value === "object") {
      result[key] = redactObject(value, fields);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function redactAttributesInPlace(
  attrs: Record<string, unknown>,
  fields: ReadonlyArray<string> = PII_FIELDS,
  otelKeys: ReadonlyArray<string> = OTEL_PII_SPAN_ATTRS
): void {
  const fieldSet = fields === PII_FIELDS ? DEFAULT_PII_FIELD_SET : new Set(fields);
  const otelKeySet =
    otelKeys === OTEL_PII_SPAN_ATTRS
      ? DEFAULT_OTEL_PII_SPAN_ATTR_SET
      : new Set(otelKeys);

  for (const [key, value] of Object.entries(attrs)) {
    if (fieldSet.has(key) || otelKeySet.has(key)) {
      // url.full/url.query are fully masked instead of query-stripped so malformed
      // URL strings cannot bypass redaction through parser edge cases.
      attrs[key] = "***";
    } else if (value !== null && typeof value === "object") {
      attrs[key] = redactObject(value, fields);
    }
  }
}

// ─── Processor classes ────────────────────────────────────────────────────────

const HTTP_RESPONSE_STATUS_CODE_ATTR = "http.response.status_code";

function isSuccessfulSpan(span: ReadableSpan): boolean {
  if (span.status.code === SpanStatusCode.ERROR) return false;

  const statusCode = Number(span.attributes[HTTP_RESPONSE_STATUS_CODE_ATTR]);
  return !Number.isFinite(statusCode) || statusCode < 400;
}

function isHealthRequestSpan(span: ReadableSpan): boolean {
  if (span.name === "Functions.health") return true;
  return span.kind === SpanKind.SERVER && span.name.toLowerCase().includes("health");
}

function clearSampledFlag(span: ReadableSpan): void {
  const spanContext = span.spanContext();
  // Azure Monitor's exporter samples from SpanContext.traceFlags. Some real SDK
  // spans may return a derived/frozen context, so deploy smoke must confirm this
  // on Azure Functions; unit tests prove the intended mutation for stable contexts.
  spanContext.traceFlags &= ~TraceFlags.SAMPLED;
}

export class PiiRedactingLogRecordProcessor implements LogRecordProcessor {
  private readonly fields: ReadonlyArray<string>;

  constructor(fields: ReadonlyArray<string> = PII_FIELDS) {
    this.fields = fields;
  }

  onEmit(logRecord: SdkLogRecord, _context?: Context): void {
    for (const field of this.fields) {
      logRecord.setAttribute(field, "***");
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export class PiiRedactingSpanProcessor implements SpanProcessor {
  private readonly fields: ReadonlyArray<string>;

  constructor(fields: ReadonlyArray<string> = PII_FIELDS) {
    this.fields = fields;
  }

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    redactAttributesInPlace(span.attributes, this.fields, OTEL_PII_SPAN_ATTRS);

    if (isHealthRequestSpan(span) && isSuccessfulSpan(span)) {
      clearSampledFlag(span);
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
