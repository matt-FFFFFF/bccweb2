import { useState, useEffect } from "react";

interface BriefImagesProps {
  imagePaths: string[];
  roundId: string;
}

export function BriefImages({ imagePaths, roundId }: BriefImagesProps) {
  const [imageUrls, setImageUrls] = useState<string[]>([]);

  useEffect(() => {
    if (!roundId || !imagePaths || imagePaths.length === 0) {
      setImageUrls([]);
      return;
    }

    let cancelled = false;
    const objectUrls: string[] = [];
    const accessToken = localStorage.getItem("bcc_access_token");
    const headers: Record<string, string> = {};
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

    Promise.all(
      imagePaths.map(async (_path, index) => {
        const res = await fetch(`/api/rounds/${roundId}/brief/images/${index + 1}`, { headers });
        if (!res.ok) return "";
        const url = URL.createObjectURL(await res.blob());
        objectUrls.push(url);
        return url;
      })
    ).then((urls) => {
      if (cancelled) {
        urls.forEach((url) => { if (url) URL.revokeObjectURL(url); });
        return;
      }
      setImageUrls(urls);
    }).catch(() => {
      if (!cancelled) setImageUrls([]);
    });

    return () => {
      cancelled = true;
      objectUrls.forEach((url) => { if (url) URL.revokeObjectURL(url); });
    };
  }, [roundId, imagePaths]);

  if (!imagePaths || imagePaths.length === 0) return null;

  return (
    <div style={{ marginTop: "1rem" }}>
      <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.6rem", color: "#1a4fa0" }}>
        Briefing Images
      </h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
        {imagePaths.map((path, index) => (
          <div key={path} style={{ width: 220 }}>
            {imageUrls[index] ? (
              <img
                src={imageUrls[index]}
                alt={`Briefing image ${index + 1}`}
                style={{ width: "100%", height: "auto", borderRadius: "0.35rem", border: "1px solid #dee2e6" }}
              />
            ) : (
              <span style={{ color: "#666", fontSize: "0.85rem" }}>Image unavailable</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
