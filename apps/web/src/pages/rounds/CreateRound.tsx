import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { SiteSummary, SeasonSummary, Round } from "@bccweb/types";
import { useBlob } from "../../hooks/useBlob.js";
import { useAuth } from "../../hooks/useAuth.js";
import { api } from "../../lib/api.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";

export default function CreateRound() {
  const navigate = useNavigate();
  const { identity, loading: authLoading } = useAuth();

  const { data: sites, loading: sitesLoading } = useBlob<SiteSummary[]>("sites.json");
  const { data: seasons, loading: seasonsLoading } = useBlob<SeasonSummary[]>("seasons.json");

  const [form, setForm] = useState({
    date: "",
    siteId: "",
    seasonYear: "",
    maxTeams: "8",
    minimumScore: "0",
    briefingTime: "",
    landByTime: "",
    checkInByTime: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCoord =
    identity?.roles.includes("RoundsCoord") ||
    identity?.roles.includes("Admin");

  if (authLoading || sitesLoading || seasonsLoading) {
    return <LoadingSpinner message="Loading…" />;
  }

  if (!identity || !isCoord) {
    return (
      <div style={{ maxWidth: 500, margin: "2rem auto" }}>
        <p style={{ color: "#721c24" }}>
          You must be signed in as a Rounds Coordinator or Admin to create rounds.
        </p>
      </div>
    );
  }

  function set(field: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!form.date || !form.siteId || !form.seasonYear) {
      setError("Date, site and season are required.");
      return;
    }

    setSubmitting(true);
    try {
      const round = await api.post<Round>("rounds", {
        date: form.date,
        siteId: form.siteId,
        seasonYear: Number(form.seasonYear),
        maxTeams: Number(form.maxTeams),
        minimumScore: Number(form.minimumScore),
        briefingTime: form.briefingTime || undefined,
        landByTime: form.landByTime || undefined,
        checkInByTime: form.checkInByTime || undefined,
      });
      navigate(`/rounds/${round.id}/manage`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create round.");
    } finally {
      setSubmitting(false);
    }
  }

  const activeSites = (sites ?? []).filter((s) => s.status === "Active");
  const sortedSeasons = (seasons ?? []).slice().sort((a, b) => b.year - a.year);

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontWeight: 600,
    fontSize: "0.85rem",
    color: "#555",
    marginBottom: "0.25rem",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "0.45rem 0.6rem",
    border: "1px solid #ccc",
    borderRadius: "0.3rem",
    fontSize: "0.95rem",
    boxSizing: "border-box",
  };

  const fieldStyle: React.CSSProperties = { marginBottom: "1rem" };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      {/* Breadcrumb */}
      <nav style={{ marginBottom: "1rem", fontSize: "0.85rem", color: "#888" }}>
        <Link to="/rounds" style={{ color: "#0066cc", textDecoration: "none" }}>
          Rounds
        </Link>{" "}
        / Create Round
      </nav>

      <h1 style={{ fontSize: "1.5rem", marginTop: 0 }}>Create Round</h1>

      {error && (
        <div
          style={{
            background: "#f8d7da",
            color: "#58151c",
            padding: "0.75rem 1rem",
            borderRadius: "0.4rem",
            marginBottom: "1rem",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={(e) => { void handleSubmit(e); }}>
        {/* Date */}
        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="date">Date</label>
          <input
            id="date"
            type="date"
            required
            style={inputStyle}
            value={form.date}
            onChange={(e) => set("date", e.target.value)}
          />
        </div>

        {/* Site */}
        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="siteId">Site</label>
          <select
            id="siteId"
            required
            style={inputStyle}
            value={form.siteId}
            onChange={(e) => set("siteId", e.target.value)}
          >
            <option value="">— select site —</option>
            {activeSites.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {/* Season */}
        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="seasonYear">Season</label>
          <select
            id="seasonYear"
            required
            style={inputStyle}
            value={form.seasonYear}
            onChange={(e) => set("seasonYear", e.target.value)}
          >
            <option value="">— select season —</option>
            {sortedSeasons.map((s) => (
              <option key={s.year} value={String(s.year)}>
                {s.year}{s.active ? " (active)" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Grid row: maxTeams + minimumScore */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
          <div>
            <label style={labelStyle} htmlFor="maxTeams">Max Teams</label>
            <input
              id="maxTeams"
              type="number"
              min={1}
              max={100}
              style={inputStyle}
              value={form.maxTeams}
              onChange={(e) => set("maxTeams", e.target.value)}
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="minimumScore">Minimum Score</label>
            <input
              id="minimumScore"
              type="number"
              min={0}
              step={0.1}
              style={inputStyle}
              value={form.minimumScore}
              onChange={(e) => set("minimumScore", e.target.value)}
            />
          </div>
        </div>

        {/* Time fields */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
          <div>
            <label style={labelStyle} htmlFor="briefingTime">Briefing Time</label>
            <input
              id="briefingTime"
              type="time"
              style={inputStyle}
              value={form.briefingTime}
              onChange={(e) => set("briefingTime", e.target.value)}
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="checkInByTime">Check-in By</label>
            <input
              id="checkInByTime"
              type="time"
              style={inputStyle}
              value={form.checkInByTime}
              onChange={(e) => set("checkInByTime", e.target.value)}
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="landByTime">Land By</label>
            <input
              id="landByTime"
              type="time"
              style={inputStyle}
              value={form.landByTime}
              onChange={(e) => set("landByTime", e.target.value)}
            />
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginTop: "1.5rem" }}>
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: "0.55rem 1.25rem",
              background: submitting ? "#6c757d" : "#0066cc",
              color: "#fff",
              border: "none",
              borderRadius: "0.35rem",
              fontWeight: 600,
              fontSize: "0.95rem",
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "Creating…" : "Create Round"}
          </button>
          <Link
            to="/rounds"
            style={{ color: "#555", textDecoration: "none", fontSize: "0.9rem" }}
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
