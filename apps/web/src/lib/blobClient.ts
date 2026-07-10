// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Direct blob storage reads for public data.
 *
 * In local development, the Vite server proxies `/blob/*` to Azurite
 * (see vite.config.ts). In production, VITE_BLOB_BASE_URL is set to the
 * storage account blob endpoint for the data container, e.g.:
 *   https://stbccwebprod.blob.core.windows.net/data
 *
 * The blob container must have blob-level public access enabled.
 */

import type * as z from "zod/v4";

const BLOB_BASE: string =
  (import.meta.env["VITE_BLOB_BASE_URL"] as string | undefined) ?? "/blob";

export class BlobNotFoundError extends Error {
  constructor(path: string) {
    super(`Blob not found: ${path}`);
    this.name = "BlobNotFoundError";
  }
}

/**
 * Fetch and JSON-parse a public blob. Throws BlobNotFoundError on 404,
 * Error on other failures.
 *
 * If a `schema` is provided, the response is validated with Zod's safeParse:
 *   - On success: returns the parsed (and healed) value.
 *   - On failure in DEV (`import.meta.env.DEV`): warns to console and STILL
 *     returns the raw cast — easier to iterate locally without breakage.
 *   - On failure in PROD: throws `Error("DATA_SHAPE_INVALID:<path>")`.
 *
 * If `schema` is omitted, the body is cast to T with no validation
 * (preserves existing behaviour for incremental adoption).
 */
export async function readPublicBlob<T>(
  path: string,
  schema?: z.ZodType<T>
): Promise<T> {
  const url = `${BLOB_BASE}/${path}`;
  const res = await fetch(url, { cache: "no-store" });

  if (res.status === 404) {
    throw new BlobNotFoundError(path);
  }

  if (!res.ok) {
    throw new Error(`Blob read failed: ${path} (${res.status})`);
  }

  const raw = (await res.json()) as unknown;

  if (!schema) {
    return raw as T;
  }

  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  if (import.meta.env.DEV) {
    // Warn-only in dev so contributors can iterate without breakage.
    console.warn("blob shape mismatch", { path, issues: parsed.error.issues });
    return raw as T;
  }

  throw new Error(`DATA_SHAPE_INVALID:${path}`);
}
