// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * pii.mjs — Single source of truth for PII field definitions and redaction utilities.
 *
 * Imported by:
 *   - scripts/privacy-scan.mjs (CI success gate)
 *   - scripts/admin/anonymize-pilot.mjs (GDPR right-to-erasure)
 *
 * The TypeScript equivalent (apps/api/src/lib/telemetryRedactor.ts) maintains
 * a copy of PII_FIELDS to avoid cross-package ESM import friction.
 */

export const PII_FIELDS = [
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

/**
 * Recursively walk an object and return every location where a PII field key
 * appears. Works on plain objects and arrays; does not descend into primitives.
 *
 * @param {unknown} obj - The value to inspect.
 * @param {string[]} [fields] - Override the default PII field list.
 * @param {string} [prefix] - Internal: dot-path prefix accumulated during recursion.
 * @returns {Array<{ path: string; field: string }>}
 */
export function findPiiInObject(obj, fields = PII_FIELDS, prefix = "") {
  const hits = [];
  if (obj === null || typeof obj !== "object") return hits;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      hits.push(...findPiiInObject(obj[i], fields, `${prefix}[${i}]`));
    }
    return hits;
  }

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (fields.includes(key)) {
      hits.push({ path, field: key });
    }
    // Always recurse into nested objects/arrays regardless of whether the key matched.
    if (value !== null && typeof value === "object") {
      hits.push(...findPiiInObject(value, fields, path));
    }
  }
  return hits;
}

/**
 * Deep-clone an object, replacing the values of all PII fields with "***".
 * Array elements and nested objects are recursed; primitives are returned as-is.
 *
 * @param {unknown} obj - The value to redact.
 * @param {string[]} [fields] - Override the default PII field list.
 * @returns {unknown}
 */
export function redactObject(obj, fields = PII_FIELDS) {
  if (obj === null || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, fields));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
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
