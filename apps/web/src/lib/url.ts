/**
 * Returns `value` only when it is a safe external URL (http/https scheme),
 * otherwise `null`. Guards against `javascript:`, `data:` and other unsafe
 * schemes that would otherwise become live links when rendered in an `href`.
 * Empty, malformed, or non-http(s) input yields `null`.
 */
export function safeExternalUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
