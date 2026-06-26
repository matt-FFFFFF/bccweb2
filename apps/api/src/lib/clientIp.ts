import type { HttpRequest } from "@azure/functions";

// SECURITY: a client can prepend arbitrary X-Forwarded-For entries, so the
// LEFT-most value is spoofable and must never key rate limits or audit IPs.
// Azure App Service / Functions terminates the TCP connection at its front end
// and APPENDS the real client socket IP to the right of XFF, so the RIGHT-most
// entry is the platform-supplied, unspoofable value in this no-Front-Door
// topology. x-azure-clientip is ignored: it is Front-Door-only and, even there,
// is the client-overwritable value (x-azure-socketip is the trustworthy one).
export function trustedClientIp(req: HttpRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return null;
  const rightmost = xff.split(",").pop()?.trim();
  if (!rightmost) return null;
  return stripPort(rightmost);
}

// Azure appends `ip:port` (IPv4) or `[ipv6]:port`; keep only the address.
function stripPort(entry: string): string {
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]");
    return end > 0 ? entry.slice(1, end) : entry;
  }
  const firstColon = entry.indexOf(":");
  if (firstColon !== -1 && entry.indexOf(":", firstColon + 1) === -1) {
    return entry.slice(0, firstColon);
  }
  return entry;
}
