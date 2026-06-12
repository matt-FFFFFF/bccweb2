import { useState } from "react";
import type { Season, SeasonSummary } from "@bccweb/types";
import { useAuth } from "../../hooks/useAuth.js";
import { api, ApiError } from "../../lib/api.js";
import { useBlob } from "../../hooks/useBlob.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";

const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #ccc",
  borderRadius: "0.3rem",
  fontSize: "0.875rem",
  boxSizing: "border-box",
};

const btnStyle = (color: string, bg: string): React.CSSProperties => ({
  padding: "0.35rem 0.75rem",
  background: bg,
  color,
  border: "none",
  borderRadius: "0.3rem",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: "0.8rem",
  whiteSpace: "nowrap",
});

function Banner({ msg, ok }: { msg: string; ok?: boolean }) {
  return (
    <div style={{
      padding: "0.4rem 0.6rem",
      borderRadius: "0.3rem",
      fontSize: "0.8rem",
      background: ok ? "#d1e7dd" : "#f8d7da",
      color: ok ? "#0a3622" : "#58151c",
    }}>
      {msg}
    </div>
  );
}

function SeasonRow({
  season,
  onChanged,
}: {
  season: SeasonSummary;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<null | "activate" | "deactivate" | "delete">(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function setActive(active: boolean) {
    setBusy(active ? "activate" : "deactivate");
    setMsg(null);
    try {
      await api.put<Season>(`seasons/${season.year}`, { active });
      onChanged();
    } catch (ex) {
      setMsg(ex instanceof ApiError ? ex.message : ex instanceof Error ? ex.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete season ${season.year}? Blocked if any rounds reference it.`)) return;
    setBusy("delete");
    setMsg(null);
    try {
      await api.delete(`seasons/${season.year}`);
      onChanged();
    } catch (ex) {
      setMsg(ex instanceof ApiError ? ex.message : ex instanceof Error ? ex.message : "Delete failed");
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", padding: "0.5rem 0", borderBottom: "1px solid #f0f0f0" }}>
      <span style={{ flex: "0 0 4.5rem", fontWeight: 600, fontSize: "1rem" }}>
        {season.year}
      </span>
      <span style={{ flex: 1, fontSize: "0.8rem" }}>
        {season.active ? (
          <span style={{ color: "#0a3622", fontWeight: 600 }}>● Active</span>
        ) : (
          <span style={{ color: "#888" }}>Inactive</span>
        )}
      </span>
      {season.active ? (
        <button
          type="button"
          onClick={() => { void setActive(false); }}
          disabled={busy !== null}
          style={btnStyle("#333", "#e9ecef")}
        >
          {busy === "deactivate" ? "…" : "Deactivate"}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => { void setActive(true); }}
          disabled={busy !== null}
          style={btnStyle("#fff", "#0066cc")}
        >
          {busy === "activate" ? "…" : "Activate"}
        </button>
      )}
      <button
        type="button"
        onClick={() => { void handleDelete(); }}
        disabled={busy !== null}
        style={btnStyle("#fff", "#b02a37")}
      >
        {busy === "delete" ? "…" : "Delete"}
      </button>
      {msg && <Banner msg={msg} />}
    </div>
  );
}

function CreateSeasonForm({ onCreated }: { onCreated: () => void }) {
  const [year, setYear] = useState<string>(String(new Date().getFullYear()));
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const yearNum = Number(year);
    if (!Number.isInteger(yearNum) || yearNum < 2000) {
      setMsg("Enter a valid year.");
      setMsgOk(false);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.post<Season>("seasons", { year: yearNum, active });
      setActive(false);
      setMsg(`Season ${yearNum} created.`);
      setMsgOk(true);
      onCreated();
    } catch (ex) {
      setMsg(ex instanceof ApiError ? ex.message : ex instanceof Error ? ex.message : "Failed");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => { void submit(e); }}
      style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "2px solid #dee2e6", display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}
    >
      <div>
        <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Year</label>
        <input
          type="number"
          min={2000}
          max={9999}
          required
          style={{ ...inputStyle, width: 110 }}
          value={year}
          onChange={(e) => setYear(e.target.value)}
        />
      </div>
      <label style={{ fontSize: "0.85rem", display: "flex", gap: "0.35rem", alignItems: "center", marginBottom: "0.4rem" }}>
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        Make active
      </label>
      <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0a6640")}>
        {busy ? "Creating…" : "Create Season"}
      </button>
      {msg && <Banner msg={msg} ok={msgOk} />}
    </form>
  );
}

export default function AdminSeasons() {
  const { identity, loading: authLoading } = useAuth();
  const [refresh, setRefresh] = useState(0);
  const { data: seasons, loading: seasonsLoading } = useBlob<SeasonSummary[]>(`seasons.json?v=${refresh}`);

  const isAdmin = identity?.roles.includes("Admin") ?? false;

  if (authLoading || seasonsLoading) return <LoadingSpinner message="Loading seasons…" />;
  if (!isAdmin) return <p style={{ color: "#721c24" }}>Admin access required.</p>;

  const sorted = (seasons ?? []).slice().sort((a, b) => b.year - a.year);
  const activeCount = sorted.filter((s) => s.active).length;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>Seasons</h1>
      <p style={{ color: "#666", fontSize: "0.85rem", marginTop: 0 }}>
        Exactly one season should be active at a time. Activating one auto-deactivates the others.
        Rounds reference a season, so a season cannot be deleted while it has rounds.
      </p>

      {activeCount === 0 && sorted.length > 0 && (
        <div style={{ background: "#fff3cd", color: "#664d03", padding: "0.5rem 0.75rem", borderRadius: "0.3rem", fontSize: "0.85rem", marginBottom: "1rem" }}>
          ⚠ No active season. Pilots may see stale data until you activate one below.
        </div>
      )}

      <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "0.75rem 1rem" }}>
        {sorted.length === 0 && (
          <p style={{ color: "#888", fontSize: "0.85rem", margin: "0.25rem 0" }}>
            No seasons yet. Create one below.
          </p>
        )}
        {sorted.map((s) => (
          <SeasonRow key={s.year} season={s} onChanged={() => setRefresh((v) => v + 1)} />
        ))}
        <CreateSeasonForm onCreated={() => setRefresh((v) => v + 1)} />
      </div>
    </div>
  );
}
