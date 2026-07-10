// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState, useEffect } from "react";

interface AuthImageProps {
  src: string;
  alt: string;
  style?: React.CSSProperties;
}

export function AuthImage({ src, alt, style }: AuthImageProps) {
  const [url, setUrl] = useState<string>("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setFailed(false);
    setUrl("");

    const token = localStorage.getItem("bcc_access_token");
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    fetch(src, { headers })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (failed) return <span style={{ color: "#666", fontSize: "0.8rem" }}>Image unavailable</span>;
  if (!url) return <span style={{ color: "#666", fontSize: "0.8rem" }}>…</span>;
  return <img src={url} alt={alt} style={style} />;
}
