import type { HttpRequest } from "@azure/functions";

// SECURITY: Azure App Service overwrites the `client-ip` header with the real
// client socket IP at its front end — unspoofable, and empirically verified on a
// bare Linux/Node Flex Consumption Function App with no Front Door. Use it. The
// other candidates are attacker-controlled on this topology: `x-azure-clientip`
// is a Front-Door-only header (absent here, and passed through verbatim if a
// client sends it), and the LEFT-most `x-forwarded-for` entry is client-supplied
// (the platform appends the real IP at the END). The right-most XFF hop is only
// a local/dev fallback for when `client-ip` is absent.
export function trustedClientIp(req: HttpRequest): string | null {
  const direct = req.headers.get("client-ip");
  if (direct) return stripPort(direct);
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return null;
  const rightmost = xff.split(",").pop()?.trim();
  return rightmost ? stripPort(rightmost) : null;
}

// Azure stamps `ip:port` (IPv4) or `[ipv6]:port`; keep only the address.
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
