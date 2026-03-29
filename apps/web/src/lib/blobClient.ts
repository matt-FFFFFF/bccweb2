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
 */
export async function readPublicBlob<T>(path: string): Promise<T> {
  const url = `${BLOB_BASE}/${path}`;
  const res = await fetch(url, { cache: "no-store" });

  if (res.status === 404) {
    throw new BlobNotFoundError(path);
  }

  if (!res.ok) {
    throw new Error(`Blob read failed: ${path} (${res.status})`);
  }

  return res.json() as Promise<T>;
}
