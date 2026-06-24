// Migration transforms extracted from migrate.mjs. No SQL-driver (mssql) or uuid-package dependency, so this module is safe to import from any test context without installing @bccweb/migrate's deps.
// Note: manufacturerFromLegacyRow / legacyMigratedSignature call getOrCreateUuid(), which may read/write .migration-state/id-map.json — i.e. these two are not strictly side-effect-free.
import { getOrCreateUuid } from "./id-map.mjs";

export function briefImageBlobFromLegacy(image) {
  if (image == null) return null;
  if (Buffer.isBuffer(image)) return image.length > 0 ? image : null;
  if (image instanceof Uint8Array) {
    const bytes = Buffer.from(image);
    return bytes.length > 0 ? bytes : null;
  }
  if (typeof image === "string" && image.trim().length > 0) {
    const bytes = Buffer.from(image, "base64");
    return bytes.length > 0 ? bytes : null;
  }
  return null;
}

export function briefImagePath(roundId, imageNumber = 1) {
  return `round-briefs/${roundId}/image-${imageNumber}.png`;
}

export function normalizeWebsiteUrl(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function manufacturerFromLegacyRow(r) {
  const websiteUrl = normalizeWebsiteUrl(r.WebsiteUrl);
  return {
    id: getOrCreateUuid("manufacturer", r.ID),
    legacyId: r.ID,
    name: r.Name,
    ...(websiteUrl ? { websiteUrl } : {}),
  };
}

export function legacySignaturePath(roundId, teamId, place) {
  return `signatures/${roundId}/${teamId}-${place}-vlegacy.json`;
}

export function legacyMigratedSignature({ roundId, teamId, place, pilotId, stableKey, legacyId }) {
  return {
    id: getOrCreateUuid("signature", stableKey ?? `${roundId}-${teamId}-${place}`),
    roundId,
    teamId,
    place,
    pilotId,
    userId: null,
    signedAt: null,
    briefVersion: null,
    briefHash: null,
    wordingVersion: null,
    wordingHash: null,
    ip: null,
    userAgent: null,
    source: "legacy-migrated",
    ...(legacyId != null ? { legacyId } : {}),
  };
}
