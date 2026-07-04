/**
 * Wing-manufacturer resolution for pilot write paths.
 *
 * A pilot's `wingManufacturer` is a denormalised {id,name,websiteUrl?} snapshot.
 * On every write we re-canonicalise it against the public `manufacturers.json`
 * reference list so a stale/typo'd name the client sent cannot be persisted.
 *
 * The lookup is skipped when the id is UNCHANGED: after an admin deletes a
 * manufacturer, a pilot re-saving their (otherwise-untouched) profile must not
 * be locked out just because the id no longer resolves. Validation only fires
 * when the caller actually changes the manufacturer.
 */

import type { ManufacturerRef } from "@bccweb/types";
import { ManufacturersIndexSchema } from "@bccweb/schemas";

import { getBlobClient } from "./blob.js";
import { readJson } from "./blobJson.js";
import { HttpError } from "./http.js";

/**
 * Resolve the wingManufacturer to persist for a pilot write.
 *
 * @param existing the manufacturer already stored on the pilot (undefined for creates)
 * @param incoming the manufacturer supplied in the request body (undefined = leave untouched)
 * @returns the canonical ManufacturerRef to store, or `existing` when unchanged/omitted
 * @throws HttpError(400, "MANUFACTURER_NOT_FOUND") when a newly-set id is unknown
 */
export async function resolveWingManufacturer(
  existing: ManufacturerRef | undefined,
  incoming: ManufacturerRef | undefined,
): Promise<ManufacturerRef | undefined> {
  // Omitted → leave the existing value exactly as-is.
  if (incoming === undefined) return existing;

  // Unchanged id → no lookup (prevents self-save lockout after a deletion).
  if (incoming.id === existing?.id) return existing;

  let manufacturers: ManufacturerRef[];
  try {
    manufacturers = await readJson(
      getBlobClient("manufacturers.json"),
      ManufacturersIndexSchema,
      "manufacturers.json",
    );
  } catch (err: unknown) {
    // A missing reference list must not 500 the pilot write — treat as empty
    // (the id will then be reported as unknown below).
    if ((err as { statusCode?: number }).statusCode === 404) {
      manufacturers = [];
    } else {
      throw err;
    }
  }

  const found = manufacturers.find((m) => m.id === incoming.id);
  if (!found) {
    throw new HttpError(400, "MANUFACTURER_NOT_FOUND", "Unknown wing manufacturer");
  }

  // Canonical snapshot: id + name (+ websiteUrl only when the list carries it).
  // legacyId is intentionally dropped — ManufacturerRef is the display shape.
  return {
    id: found.id,
    name: found.name,
    ...(found.websiteUrl !== undefined ? { websiteUrl: found.websiteUrl } : {}),
  };
}
