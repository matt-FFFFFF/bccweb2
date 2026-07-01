import { useState, useEffect } from "react";

interface BriefImagesProps {
  imagePaths: string[];
  roundId: string;
}

export function BriefImages({ imagePaths, roundId }: BriefImagesProps) {
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null);

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

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

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
              <button
                type="button"
                onClick={() => setLightbox({ url: imageUrls[index], alt: `Briefing image ${index + 1}` })}
                aria-label={`Enlarge briefing image ${index + 1}`}
                style={{ display: "block", width: "100%", padding: 0, border: "none", background: "none", cursor: "zoom-in" }}
              >
                <img
                  src={imageUrls[index]}
                  alt={`Briefing image ${index + 1}`}
                  style={{ width: "100%", height: "auto", borderRadius: "0.35rem", border: "1px solid #dee2e6" }}
                />
              </button>
            ) : (
              <span style={{ color: "#666", fontSize: "0.85rem" }}>Image unavailable</span>
            )}
          </div>
        ))}
      </div>

      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Enlarged briefing image"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
          }}
        >
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="Close enlarged image"
            style={{ position: "absolute", inset: 0, padding: 0, border: "none", background: "none", cursor: "zoom-out" }}
          />
          <img
            src={lightbox.url}
            alt={lightbox.alt}
            style={{
              position: "relative",
              maxWidth: "95vw",
              maxHeight: "95vh",
              objectFit: "contain",
              borderRadius: "0.35rem",
              boxShadow: "0 0 40px rgba(0,0,0,0.5)",
              pointerEvents: "none",
            }}
          />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="Close"
            style={{
              position: "absolute",
              top: "0.75rem",
              right: "1.25rem",
              fontSize: "2.5rem",
              lineHeight: 1,
              color: "#fff",
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
