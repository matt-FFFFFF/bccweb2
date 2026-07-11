// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

const REDACTED = "[REDACTED]";
const SAS_KEYS = new Set([
  "sig", "se", "sp", "sv", "st", "spr", "sr",
  "skoid", "sktid", "skt", "ske", "sks", "skv",
]);
const PATTERNS = [
  [/((?:"|')?(?:access_?token|refresh_?token|id_?token|token|password|password_?hash)(?:"|')?\s*[:=]\s*(?:"|'))[^"']*((?:"|'))/giu, `$1${REDACTED}$2`],
  [/(Authorization\s*[:=]\s*["']?Bearer\s+)(?!\[REDACTED\])[^\s"']+/giu, `$1${REDACTED}`],
  [/(\bBearer\s+)(["']?)(?!\[REDACTED\])[^\s"']+(["']?)/giu, `$1$2${REDACTED}$3`],
  [/((?:AccountKey|SharedAccessKey|SharedAccessSignature)\s*[:=]\s*)[^;\s]+/giu, `$1${REDACTED}`],
  [/((?:SAS_?TOKEN|ADMIN_PASSWORD|JWT_SECRET|ACCESS_?TOKEN)\s*[:=]\s*)[^\s]+/giu, `$1${REDACTED}`],
  [/(\b(?:access_?token|refresh_?token|id_?token|token)\s*[:=]\s*)(?!["'])[^\s,;}]+/giu, `$1${REDACTED}`],
  [/(BCC ADMIN PASSWORD:\s*)[^\s]+/giu, `$1${REDACTED}`],
  [/([?&](?:sig|se|sp|sv|st|spr|sr|skoid|sktid|skt|ske|sks|skv)=)[^&;\s]+/giu, `$1${REDACTED}`],
  [/(\b(?:sig|se|sp|sv|st|spr|sr|skoid|sktid|skt|ske|sks|skv)\s*[:=]\s*)[^&;\s]+/giu, `$1${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED],
];

function normalizedKey(key) {
  let decoded = key;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded.toLowerCase();
}

function redactUrl(candidate) {
  try {
    const url = new URL(candidate);
    let credentialBearing = url.username.length > 0 || url.password.length > 0;
    if (credentialBearing) {
      url.username = REDACTED;
      url.password = REDACTED;
    }
    const queryKeys = [...url.searchParams.keys()];
    if (queryKeys.some((key) => SAS_KEYS.has(normalizedKey(key)))) {
      credentialBearing = true;
      for (const key of queryKeys) url.searchParams.set(key, REDACTED);
    }
    return credentialBearing ? url.toString() : candidate;
  } catch {
    return candidate;
  }
}

export function redactLoadTestOutput(output) {
  const urlsRedacted = output.replace(/https?:\/\/[^\s"'<>]+/giu, redactUrl);
  return PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    urlsRedacted,
  );
}
