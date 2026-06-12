/**
 * RoundBrief — view page for a locked round's brief document.
 *
 * Shows:
 * - Site information (W3W links, times, PureTrack link)
 * - Teams + pilot safety data table
 * - Download PDF button
 *
 * Accessible to all authenticated users (coordinated view) — brief data is
 * fetched from the API (not a public blob) so the round ID must be known.
 */

import { useState, useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import type { RoundBrief as RoundBriefType, BriefTeamEntry, BriefPilotEntry, ManufacturerRef } from "@bccweb/types";
import { useAuth } from "../../hooks/useAuth.js";
import { ApiError } from "../../lib/api.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function w3wUrl(w3w?: string) {
  if (!w3w) return null;
  const clean = w3w.replace(/^\/\/\//, "");
  return `https://what3words.com/${clean}`;
}

function displayValue(value?: string) {
  return value?.trim() ? value : "Not provided";
}

function safeExternalUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function ManufacturerLink({ manufacturer, model }: { manufacturer?: ManufacturerRef; model?: string }) {
  if (!manufacturer) return <>{model ?? "—"}</>;
  const url = safeExternalUrl(manufacturer.websiteUrl);
  const label = `${manufacturer.name}${model ? ` ${model}` : ""}`;
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#1a4fa0" }}>
      {label}
    </a>
  ) : (
    <>{label}</>
  );
}

const safetyFields: Array<{ label: string; value: (brief: RoundBriefType) => string | undefined }> = [
  { label: "Wind Speed & Direction", value: (brief) => brief.windSpeedDirection },
  { label: "Direction of Flight", value: (brief) => brief.directionOfFlight },
  { label: "Expected Landing Area", value: (brief) => brief.expectedLandingArea },
  { label: "Airspace & Hazards", value: (brief) => brief.airspaceAndHazards },
  { label: "NOTAMs", value: (brief) => brief.NOTAMs },
  { label: "BENO Line Description", value: (brief) => brief.BENO_LineDescription },
  { label: "Briefer's Notes", value: (brief) => brief.briefersNotes },
];

function W3WLink({ value, label }: { value?: string; label: string }) {
  if (!value) return null;
  const url = w3wUrl(value);
  return (
    <div style={{ marginBottom: "0.35rem" }}>
      <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>{label}: </span>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#1a4fa0", fontSize: "0.9rem" }}>
          {value}
        </a>
      ) : (
        <span style={{ fontSize: "0.9rem" }}>{value}</span>
      )}
    </div>
  );
}

// ─── Pilot table ──────────────────────────────────────────────────────────────

function PilotTable({ pilots }: { pilots: BriefPilotEntry[] }) {
  const thStyle: React.CSSProperties = {
    background: "#f0f2f8",
    padding: "0.3rem 0.5rem",
    textAlign: "left",
    fontSize: "0.75rem",
    color: "#444",
    borderBottom: "1px solid #c8cce0",
    whiteSpace: "nowrap",
  };
  const tdStyle: React.CSSProperties = {
    padding: "0.25rem 0.5rem",
    borderBottom: "1px solid #eef0f5",
    fontSize: "0.82rem",
    verticalAlign: "top",
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
        <thead>
          <tr>
            <th style={thStyle}>#</th>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>BHPA</th>
            <th style={thStyle}>Rating</th>
            <th style={thStyle}>Wing Class</th>
            <th style={thStyle}>Wing</th>
            <th style={thStyle}>Colours</th>
            <th style={thStyle}>Helmet</th>
            <th style={thStyle}>Emergency</th>
            <th style={thStyle}>Medical</th>
          </tr>
        </thead>
        <tbody>
          {pilots.map((p) => (
            <tr key={p.pilotId}>
              <td style={tdStyle}>
                {p.placeInTeam}
                {!p.isScoring && (
                  <span style={{ color: "#999", fontStyle: "italic", fontSize: "0.75em" }}> *</span>
                )}
              </td>
              <td style={tdStyle}>
                <Link to={`/pilots/${p.pilotId}`} style={{ color: "#1a4fa0", textDecoration: "none" }}>
                  {p.name}
                </Link>
              </td>
              <td style={{ ...tdStyle, color: "#666" }}>{p.bhpaNumber ?? "—"}</td>
              <td style={tdStyle}>{p.snapshot.pilotRating}</td>
              <td style={tdStyle}>{p.snapshot.wingClass}</td>
              <td style={tdStyle}>
                <ManufacturerLink manufacturer={p.wingManufacturer} model={p.snapshot.wingModel} />
              </td>
              <td style={tdStyle}>{p.snapshot.wingColours ?? "—"}</td>
              <td style={tdStyle}>{p.snapshot.helmetColour ?? "—"}</td>
              <td style={tdStyle}>
                {p.snapshot.emergencyContactName ? (
                  <>
                    {p.snapshot.emergencyContactName}
                    {p.snapshot.emergencyPhoneNumber && (
                      <><br /><span style={{ color: "#666" }}>{p.snapshot.emergencyPhoneNumber}</span></>
                    )}
                  </>
                ) : "—"}
              </td>
              <td style={{ ...tdStyle, color: p.snapshot.medicalInfo ? "#8b0000" : "#999", fontWeight: p.snapshot.medicalInfo ? 700 : 400 }}>
                {p.snapshot.medicalInfo ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: "0.75rem", color: "#888", marginTop: "0.3rem" }}>
        * = non-scoring pilot
      </p>
    </div>
  );
}

// ─── Team section ─────────────────────────────────────────────────────────────

function TeamSection({ team }: { team: BriefTeamEntry }) {
  const captain = team.pilots.find((p) => p.placeInTeam === 1);

  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          background: "#e8edf8",
          padding: "0.4rem 0.75rem",
          borderRadius: "4px 4px 0 0",
          marginBottom: 0,
        }}
      >
        <div>
          <strong style={{ fontSize: "1rem" }}>{team.teamName}</strong>
          <span style={{ marginLeft: "0.5rem", color: "#555", fontSize: "0.85rem" }}>
            — {team.clubName}
          </span>
          {captain && (
            <span style={{ marginLeft: "0.75rem", fontSize: "0.8rem", color: "#444" }}>
              Captain: <strong>{captain.name}</strong>
            </span>
          )}
        </div>
        {team.pureTrackGroupSlug && (
          <a
            href={`https://puretrack.io/group/${team.pureTrackGroupSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "0.8rem", color: "#1a4fa0" }}
          >
            PureTrack ↗
          </a>
        )}
      </div>
      <div
        style={{
          border: "1px solid #c8cce0",
          borderTop: "none",
          borderRadius: "0 0 4px 4px",
          overflow: "hidden",
        }}
      >
        <PilotTable pilots={team.pilots} />
      </div>
    </div>
  );
}

function SafetyBriefingSection({
  brief,
  imageUrls,
}: {
  brief: RoundBriefType;
  imageUrls: string[];
}) {
  const fieldStyle: React.CSSProperties = {
    padding: "0.65rem",
    border: "1px solid #e3e8f2",
    borderRadius: "0.35rem",
    background: "#fff",
  };
  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: "0.25rem",
    color: "#555",
    fontSize: "0.8rem",
    fontWeight: 700,
  };
  const valueStyle: React.CSSProperties = {
    whiteSpace: "pre-wrap",
    color: "#222",
    fontSize: "0.92rem",
  };

  return (
    <section
      style={{
        marginBottom: "1.5rem",
        padding: "1rem",
        border: "1px solid #dee2e6",
        borderRadius: "0.5rem",
        background: "#fbfcff",
      }}
    >
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem", color: "#1a4fa0" }}>
        Safety Briefing
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "0.75rem",
        }}
      >
        {safetyFields.map((field) => (
          <div key={field.label} style={fieldStyle}>
            <span style={labelStyle}>{field.label}</span>
            <span style={valueStyle}>{displayValue(field.value(brief))}</span>
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: "0.95rem", margin: "1rem 0 0.6rem", color: "#1a4fa0" }}>
        Briefer Contact
      </h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: "0.5rem 1rem",
        }}
      >
        <div><span style={labelStyle}>Name</span>{displayValue(brief.briefer?.name)}</div>
        <div><span style={labelStyle}>BHPA Coach Level</span>{displayValue(brief.briefer?.bhpaCoachLevel)}</div>
        <div><span style={labelStyle}>BHPA Number</span>{displayValue(brief.briefer?.bhpaNumber)}</div>
        <div><span style={labelStyle}>Phone</span>{displayValue(brief.briefer?.phoneNumber)}</div>
        <div><span style={labelStyle}>Email</span>{displayValue(brief.briefer?.emailAddress)}</div>
      </div>

      {brief.imagePaths && brief.imagePaths.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.6rem", color: "#1a4fa0" }}>
            Briefing Images
          </h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
            {brief.imagePaths.map((path, index) => (
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
      )}
    </section>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function RoundBrief() {
  const { id } = useParams<{ id: string }>();
  const { identity, loading: authLoading } = useAuth();

  const [brief, setBrief] = useState<RoundBriefType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [imageUrls, setImageUrls] = useState<string[]>([]);

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

  useEffect(() => {
    if (!id || !brief?.imagePaths?.length) {
      setImageUrls([]);
      return;
    }

    let cancelled = false;
    const objectUrls: string[] = [];
    const accessToken = localStorage.getItem("bcc_access_token");
    const headers: Record<string, string> = {};
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

    Promise.all(
      brief.imagePaths.map(async (_path, index) => {
        const res = await fetch(`/api/rounds/${id}/brief/images/${index + 1}`, { headers });
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
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [id, brief]);

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
      // Prefer the server-supplied filename from Content-Disposition
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

  // Auth gate — brief contains pilot safety data; require sign-in
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
      {/* Breadcrumb */}
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

      {/* Header */}
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

      {/* Site info */}
      <section
        style={{
          marginBottom: "1.5rem",
          padding: "1rem",
          border: "1px solid #dee2e6",
          borderRadius: "0.5rem",
        }}
      >
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem", color: "#1a4fa0" }}>
          Site Information
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "0.5rem 1.5rem",
          }}
        >
          {brief.briefingTime && (
            <div>
              <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>Briefing: </span>
              <span>{brief.briefingTime}</span>
            </div>
          )}
          {brief.checkInByTime && (
            <div>
              <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>Check-in By: </span>
              <span>{brief.checkInByTime}</span>
            </div>
          )}
          {brief.landByTime && (
            <div>
              <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>Land By: </span>
              <span>{brief.landByTime}</span>
            </div>
          )}
          {brief.pureTrackGroupName && (
            <div>
              <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>PureTrack: </span>
              <a
                href={`https://puretrack.io/group/${brief.pureTrackGroupSlug}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#1a4fa0" }}
              >
                {brief.pureTrackGroupName}
              </a>
            </div>
          )}
          {brief.guideUrl && (
            <div>
              <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>Site Guide: </span>
              <a href={brief.guideUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#1a4fa0" }}>
                Open guide ↗
              </a>
            </div>
          )}
          {brief.frequencyMhz !== undefined && (
            <div>
              <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>Frequency: </span>
              <span>{brief.frequencyMhz} MHz</span>
            </div>
          )}
        </div>
        <div style={{ marginTop: "0.75rem" }}>
          <W3WLink value={brief.parkingW3W} label="Parking" />
          <W3WLink value={brief.briefingW3W} label="Briefing" />
          <W3WLink value={brief.takeOffW3W} label="Take-off" />
        </div>
      </section>

      <SafetyBriefingSection brief={brief} imageUrls={imageUrls} />

      {/* Teams */}
      <section>
        <h2 style={{ fontSize: "1rem", margin: "0 0 1rem", color: "#1a4fa0" }}>
          Teams &amp; Pilots ({brief.teams.length} teams)
        </h2>
        {brief.teams.length === 0 ? (
          <p style={{ color: "#888" }}>No teams registered.</p>
        ) : (
          brief.teams.map((team) => (
            <TeamSection key={team.teamName} team={team} />
          ))
        )}
      </section>

      {/* Footer */}
      <p style={{ fontSize: "0.75rem", color: "#aaa", marginTop: "1.5rem" }}>
        Generated: {new Date(brief.generatedAt).toLocaleString("en-GB")}
      </p>
    </div>
  );
}
