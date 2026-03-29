import { useState, useEffect } from "react";
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
 * @example
 * const { data, loading, error } = useBlob<RoundSummary[]>("rounds.json");
 */
export function useBlob<T>(path: string | null): BlobState<T> {
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

    readPublicBlob<T>(path)
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

    return () => {
      cancelled = true;
    };
  }, [path]);

  return state;
}
