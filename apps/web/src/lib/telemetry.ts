const PII_FIELDS: ReadonlyArray<string> = [
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
  "wingColours",
];

export function redactObject(
  obj: unknown,
  fields: ReadonlyArray<string> = PII_FIELDS
): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => redactObject(item, fields));
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

export function setup(): void {
  const connectionString = (import.meta as unknown as {
    env?: Record<string, string | undefined>;
  }).env?.["VITE_APP_INSIGHTS_CONNECTION_STRING"];

  if (!connectionString) {
    return;
  }

  // SPA RUM (Real User Monitoring) is intentionally deferred — the
  // @microsoft/applicationinsights-web bundle (~50KB gzipped) is not justified
  // until we have a concrete RUM use case (Wave 8+). When enabling:
  //   1. npm install --workspace=@bccweb/web @microsoft/applicationinsights-web
  //   2. Replace the warn below with an ApplicationInsights init + addTelemetryInitializer
  //      that wraps every envelope in `redactObject(envelope.data.baseData)` using
  //      the PII_FIELDS list above (kept in sync with apps/api/src/lib/telemetryRedactor.ts).
  //   3. Wire the build pipeline to surface VITE_APP_INSIGHTS_CONNECTION_STRING from the
  //      same Key Vault secret seeded by scripts/iac/seed-secrets.sh.
  // See .omo/notepads/bccweb2-go-live-gap-closure/learnings.md (Task 46) for rationale.
  // eslint-disable-next-line no-console
  console.info(
    "[telemetry] VITE_APP_INSIGHTS_CONNECTION_STRING is set but SPA RUM is currently stubbed — see apps/web/src/lib/telemetry.ts"
  );
}
