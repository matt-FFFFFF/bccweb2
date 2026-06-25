import type { HttpRequest } from "@azure/functions";

// SECURITY: the first X-Forwarded-For entry is client-supplied and trivially
// spoofable, so it must not be the source of truth for rate-limit keys, audit
// IPs, or attribution. Behind Azure (Front Door / Static Web Apps) the platform
// sets x-azure-clientip to the real client socket IP — prefer it. The XFF first
// entry is only a fallback for local/dev where the platform header is absent;
// in production x-azure-clientip is always present, so prepended XFF can't lower
// the trust. (Assumes Function App ingress is restricted to the SWA front door.)
export function trustedClientIp(req: HttpRequest): string | null {
  const azure = req.headers.get("x-azure-clientip")?.trim();
  if (azure) return azure;
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff ? xff : null;
}
