import { useState, useEffect } from "react";
import type * as z from "zod/v4";
import { readPublicBlob, BlobNotFoundError } from "../lib/blobClient.js";

export interface BlobState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  notFound: boolean;
}

/**
 * React hook for reading public blobs directly from blob storage.
 *
 * Pass `null` as `path` to skip fetching (returns loading: false, data: null).
 * Re-fetches whenever `path` changes.
 *
 * If `schema` is provided, the response is validated/healed via Zod's safeParse
 * (see {@link readPublicBlob}). In DEV, shape mismatches warn and still return
 * the raw cast; in PROD they throw `DATA_SHAPE_INVALID:<path>`.
 *
 * @example
 * const { data, loading, error } = useBlob<RoundSummary[]>(
 *   "rounds.json",
 *   z.array(RoundSummarySchema),
 * );
 */
export function useBlob<T>(
  path: string | null,
  schema?: z.ZodType<T>
): BlobState<T> {
  const [state, setState] = useState<BlobState<T>>({
    data: null,
    loading: path !== null,
    error: null,
    notFound: false,
  });

  useEffect(() => {
    if (path === null) {
      setState({ data: null, loading: false, error: null, notFound: false });
      return;
    }

    let cancelled = false;
    setState({ data: null, loading: true, error: null, notFound: false });

    readPublicBlob<T>(path, schema)
      .then((data) => {
        if (!cancelled)
          setState({ data, loading: false, error: null, notFound: false });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            data: null,
            loading: false,
            error: err as Error,
            notFound: err instanceof BlobNotFoundError,
          });
        }
      });

    // `schema` is intentionally excluded from the deps below — callers pass it
    // inline (e.g. z.array(Schema)), a new object every render, so depending on
    // it would re-fetch on every render. Re-fetch is keyed on `path` by design.
    return () => {
      cancelled = true;
    };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}
