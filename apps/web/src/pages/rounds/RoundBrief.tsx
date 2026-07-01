/**
 * RoundBrief — view page for a locked round's brief document.
 *
 * Shows the full brief (site info, safety briefing, teams + pilot safety data)
 * plus a Download PDF button. Accessible to all authenticated users; brief data
 * is fetched from the API (not a public blob) so the round ID must be known.
 */

import { useState, useEffect } from "react";
import { Link, useParams } from "react-router";
import { BriefDocument } from "../../components/BriefDocument.js";
import type { RoundBrief as RoundBriefType } from "@bccweb/types";
import { useAuth } from "../../hooks/useAuth.js";
import { ApiError } from "../../lib/api.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";

function formatDate(iso: string) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function RoundBrief() {
  const { id } = useParams<{ id: string }>();
  const { identity, loading: authLoading } = useAuth();

  const [brief, setBrief] = useState<RoundBriefType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setNotFound(false);

    const accessToken = localStorage.getItem("bcc_access_token");
    const headers: Record<string, string> = {};
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

    fetch(`/api/rounds/${id}/brief`, { headers })
      .then(async (res) => {
        if (res.status === 404) { setNotFound(true); return; }
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          setError(body.error ?? `Error ${res.status}`);
          return;
        }
        const data = await res.json() as RoundBriefType;
        setBrief(data);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load brief");
      })
      .finally(() => setLoading(false));
  }, [id]);

  async function downloadPdf() {
    if (!id) return;
    setDownloading(true);
    try {
      const accessToken = localStorage.getItem("bcc_access_token");
      const headers: Record<string, string> = {};
      if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

      const res = await fetch(`/api/rounds/${id}/brief/pdf`, { headers });
      if (!res.ok) throw new ApiError(res.status, "DOWNLOAD_FAILED", `Could not download PDF (${res.status})`);

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      a.download = match?.[1] ?? `BCC-Brief-${id}.pdf`;
      a.href = url;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  const isCoord =
    identity?.roles.includes("RoundsCoord") ||
    identity?.roles.includes("Admin") ||
    identity?.roles.includes("Pilot");

  if (authLoading || loading) return <LoadingSpinner message="Loading brief…" />;

  if (!identity || !isCoord) {
    return (
      <div style={{ maxWidth: 500, margin: "2rem auto" }}>
        <p style={{ color: "#721c24" }}>
          You must be signed in to view the round brief.
        </p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div style={{ maxWidth: 600, margin: "2rem auto" }}>
        <p style={{ color: "#664d03" }}>
          Round brief not found. The round may not be locked yet, or brief generation is still in progress — please try again in a minute.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ maxWidth: 600, margin: "2rem auto" }}>
        <p style={{ color: "#721c24" }}>{error}</p>
      </div>
    );
  }

  if (!brief) return null;

  const coordOrAdmin =
    identity.roles.includes("RoundsCoord") || identity.roles.includes("Admin");

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <nav style={{ marginBottom: "1rem", fontSize: "0.85rem", color: "#888" }}>
        <Link to="/rounds" style={{ color: "#0066cc", textDecoration: "none" }}>Rounds</Link>
        {" / "}
        <Link to={`/rounds/${brief.roundId}`} style={{ color: "#0066cc", textDecoration: "none" }}>
          {brief.siteName}
        </Link>
        {coordOrAdmin && (
          <>
            {" / "}
            <Link to={`/rounds/${brief.roundId}/manage`} style={{ color: "#0066cc", textDecoration: "none" }}>Manage</Link>
          </>
        )}
        {" / Brief"}
      </nav>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.75rem", margin: "0 0 0.2rem", color: "#1a4fa0" }}>
            BCC Round Brief
          </h1>
          <p style={{ margin: 0, color: "#444" }}>
            <strong>{brief.siteName}</strong> — {formatDate(brief.date)}
            {brief.organisingClubName && (
              <span style={{ marginLeft: "0.75rem", fontSize: "0.9rem", color: "#666" }}>
                Organised by {brief.organisingClubName}
              </span>
            )}
          </p>
        </div>
        <button
          onClick={() => { void downloadPdf(); }}
          disabled={downloading}
          style={{
            padding: "0.5rem 1rem",
            background: downloading ? "#6c757d" : "#1a4fa0",
            color: "#fff",
            border: "none",
            borderRadius: "0.35rem",
            cursor: downloading ? "not-allowed" : "pointer",
            fontWeight: 600,
            fontSize: "0.9rem",
          }}
        >
          {downloading ? "Downloading…" : "Download PDF"}
        </button>
      </div>

      <BriefDocument brief={brief} />

      <p style={{ fontSize: "0.75rem", color: "#aaa", marginTop: "1.5rem" }}>
        Generated: {new Date(brief.generatedAt).toLocaleString("en-GB")}
      </p>
    </div>
  );
}
