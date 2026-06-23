/**
 * telemetryRedactor.ts
 *
 * PII-scrubbing processors for Azure Monitor / Application Insights telemetry.
 *
 * Two processor flavours are provided:
 *
 * 1. PiiRedactingLogRecordProcessor (applicationinsights v3 / OTel-native)
 *    Implements the OpenTelemetry LogRecordProcessor interface; register via
 *    Configuration.setAzureMonitorOptions({ logRecordProcessors: [...] }).
 *    This is the active processor used in telemetry.ts.
 *
 * 2. PiiRedactingTelemetryProcessor (applicationinsights v2 compatibility shim)
 *    Works against the v2 envelope / addTelemetryProcessor API.
 *    Kept for the unit tests in telemetryRedactor.test.ts; not wired into the
 *    live SDK path because addTelemetryProcessor is a no-op in v3.
 *
 * The PII_FIELDS constant is a TS-native copy of the list maintained in
 * scripts/lib/pii.mjs (the two lists MUST be kept in sync).
 */

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

// ─── Envelope type (minimal subset, avoids hard SDK dependency) ───────────────

/**
 * Minimal shape of an Application Insights telemetry envelope.
 * Compatible with the @microsoft/applicationinsights-web and
 * applicationinsights Node.js SDK v2/v3 envelope contracts.
 */
export interface TelemetryEnvelope {
  data?: {
    baseData?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─── Processor class ──────────────────────────────────────────────────────────

/**
 * Application Insights TelemetryProcessor that redacts PII fields in-place
 * from every envelope before it is sent to the ingestion endpoint.
 *
 * The `process` method signature matches the SDK contract:
 *   (envelope: Envelope, contextObjects?: Record<string, unknown>) => boolean
 *
 * Returning `true` forwards the envelope; returning `false` drops it entirely.
 * This processor always forwards — it only scrubs, never drops.
 *
 * NOTE: addTelemetryProcessor is a no-op in applicationinsights v3.
 * This class is retained for the existing unit tests in telemetryRedactor.test.ts.
 * For the live SDK path, use PiiRedactingLogRecordProcessor below.
 */
export class PiiRedactingTelemetryProcessor {
  private readonly fields: ReadonlyArray<string>;

  constructor(fields: ReadonlyArray<string> = PII_FIELDS) {
    this.fields = fields;
    // Bind so the method can be passed directly as a callback without losing `this`.
    this.process = this.process.bind(this);
  }

  process(
    envelope: TelemetryEnvelope,
    _contextObjects?: Record<string, unknown>
  ): boolean {
    if (!envelope) return true;

    // Redact baseData (contains the primary telemetry payload).
    if (envelope.data?.baseData) {
      envelope.data.baseData = redactObject(
        envelope.data.baseData,
        this.fields
      ) as Record<string, unknown>;
    }

    // Redact any other top-level fields on the envelope itself that match PII.
    for (const field of this.fields) {
      if (Object.prototype.hasOwnProperty.call(envelope, field)) {
        (envelope as Record<string, unknown>)[field] = "***";
      }
    }

    return true;
  }
}

// ─── OTel LogRecordProcessor (applicationinsights v3) ────────────────────────

/**
 * Minimal subset of the OTel SdkLogRecord needed for PII redaction.
 * Matches the shape of @opentelemetry/sdk-logs SdkLogRecord without requiring
 * a direct dependency on that package.
 */
interface RedactableLogRecord {
  readonly attributes: Record<string, unknown>;
  setAttribute(key: string, value: unknown): unknown;
}

/**
 * OpenTelemetry LogRecordProcessor that redacts PII from log-record attributes
 * before they are exported to Azure Monitor.
 *
 * applicationinsights v3 is built on OTel; the v2 addTelemetryProcessor hook is
 * a no-op shim. Register this processor via:
 *   appInsights.setup(connectionString)
 *     ...
 *     .setAzureMonitorOptions({ logRecordProcessors: [new PiiRedactingLogRecordProcessor()] })
 *     .start();
 *
 * The trackEvent() path maps telemetry.properties into logRecord.attributes, so
 * redacting at this level scrubs PII before it leaves the process.
 */
export class PiiRedactingLogRecordProcessor {
  private readonly fields: ReadonlyArray<string>;

  constructor(fields: ReadonlyArray<string> = PII_FIELDS) {
    this.fields = fields;
  }

  onEmit(logRecord: RedactableLogRecord, _context?: unknown): void {
    for (const field of this.fields) {
      if (Object.prototype.hasOwnProperty.call(logRecord.attributes, field)) {
        logRecord.setAttribute(field, "***");
      }
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
