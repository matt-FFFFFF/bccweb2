import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import type { ClubSummary, SeasonClub } from "@bccweb/types";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";
import { useAuth } from "../../hooks/useAuth.js";
import { useBlob } from "../../hooks/useBlob.js";
import { api } from "../../lib/api.js";

const inputStyle: React.CSSProperties = {
  padding: "0.45rem 0.6rem",
  border: "1px solid #cfd7df",
  borderRadius: "0.35rem",
  fontSize: "0.9rem",
  boxSizing: "border-box",
};

const btnStyle = (color: string, bg: string): React.CSSProperties => ({
  padding: "0.45rem 0.8rem",
  background: bg,
  color,
  border: "none",
  borderRadius: "0.35rem",
  cursor: "pointer",
  fontWeight: 700,
  fontSize: "0.82rem",
  whiteSpace: "nowrap",
});

function Banner({ msg, ok }: { msg: string; ok?: boolean }) {
  return (
    <div style={{ padding: "0.55rem 0.7rem", borderRadius: "0.4rem", background: ok ? "#d1e7dd" : "#f8d7da", color: ok ? "#0a3622" : "#58151c" }}>
      {msg}
    </div>
  );
}

interface SeasonClubRow extends SeasonClub {
  clubName?: string;
}

interface RegisterResult {
  seasonClub: SeasonClub;
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

export default function SeasonClubs() {
  const { year } = useParams();
  const seasonYear = Number.parseInt(year ?? "", 10);
  const { identity, loading: authLoading } = useAuth();
  const { data: clubs, loading: clubsLoading } = useBlob<ClubSummary[]>("clubs.json");
  const [seasonClubs, setSeasonClubs] = useState<SeasonClubRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clubId, setClubId] = useState("");
  const [numTeams, setNumTeams] = useState(1);
  const [accepted, setAccepted] = useState(false);

  const clubNameById = useMemo(() => new Map((clubs ?? []).map((club) => [club.id, club.name])), [clubs]);
  const isAdmin = identity?.roles.includes("Admin");
  const canRead = isAdmin || identity?.roles.includes("RoundsCoord");

  async function load() {
    if (!Number.isInteger(seasonYear)) return;
    setLoading(true);
    try {
      const seasonClubRows = await api.get<SeasonClub[]>(`manage/seasons/${seasonYear}/clubs`);
      setSeasonClubs(seasonClubRows.map((row) => ({ ...row, clubName: clubNameById.get(row.clubId) })));
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed to load season clubs");
      setMsgOk(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!authLoading && !clubsLoading && canRead) void load();
  }, [authLoading, clubsLoading, canRead, seasonYear, isAdmin, clubNameById]);

  async function register(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.post<RegisterResult>(`manage/seasons/${seasonYear}/clubs`, {
        clubId,
        numTeams,
        acceptTsCs: accepted,
        acceptedBy: identity?.email ?? identity?.userId,
      });
      setMsg("Club registered for season.");
      setMsgOk(true);
      setShowRegister(false);
      setClubId("");
      setNumTeams(1);
      setAccepted(false);
      await load();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed to register club");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function update(row: SeasonClubRow) {
    const nextTeamsRaw = window.prompt("Number of teams", String(row.numTeams));
    if (!nextTeamsRaw) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.put<SeasonClub>(`manage/seasons/${seasonYear}/clubs/${row.id}`, {
        numTeams: Number.parseInt(nextTeamsRaw, 10),
      });
      setMsg("Season club updated.");
      setMsgOk(true);
      await load();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed to update season club");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: SeasonClubRow) {
    if (!window.confirm(`Delete ${row.clubName ?? row.clubId} from ${seasonYear}?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.deleteJson<{ id: string }>(`manage/seasons/${seasonYear}/clubs/${row.id}`);
      setMsg("Season club deleted.");
      setMsgOk(true);
      await load();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed to delete season club");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || clubsLoading || loading) return <LoadingSpinner message="Loading season clubs…" />;
  if (!canRead) return <p style={{ color: "#721c24" }}>Admin or Rounds Coordinator access required.</p>;
  if (!Number.isInteger(seasonYear)) return <p style={{ color: "#721c24" }}>Invalid season year.</p>;

  return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", marginBottom: "1.25rem", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: "1.55rem", margin: 0 }}>Season Clubs {seasonYear}</h1>
          <p style={{ margin: "0.35rem 0 0", color: "#6c757d" }}>Annual club registration, team allocation and T&C acceptance.</p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {isAdmin && <button onClick={() => setShowRegister(true)} style={btnStyle("#fff", "#0a6640")}>Register Club</button>}
        </div>
      </div>

      {msg && <div style={{ marginBottom: "1rem" }}><Banner msg={msg} ok={msgOk} /></div>}

      {showRegister && isAdmin && (
        <form onSubmit={(e) => { void register(e); }} style={{ padding: "1rem", border: "1px solid #d9e2ea", borderRadius: "0.75rem", marginBottom: "1rem", background: "#fbfcfd", display: "grid", gap: "0.75rem" }}>
          <strong>Register Club</strong>
          <select required value={clubId} onChange={(e) => setClubId(e.target.value)} style={inputStyle}>
            <option value="">Select club</option>
            {(clubs ?? []).map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}
          </select>
          <select value={numTeams} onChange={(e) => setNumTeams(Number.parseInt(e.target.value, 10))} style={inputStyle}>
            {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} team{n === 1 ? "" : "s"}</option>)}
          </select>
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            T&Cs accepted for this season
          </label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="submit" disabled={busy || !accepted} style={btnStyle("#fff", busy ? "#6c757d" : "#0a6640")}>{busy ? "Submitting…" : "Submit"}</button>
            <button type="button" onClick={() => setShowRegister(false)} style={btnStyle("#333", "#e9ecef")}>Cancel</button>
          </div>
        </form>
      )}

      <div style={{ overflowX: "auto", border: "1px solid #dee2e6", borderRadius: "0.6rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead style={{ background: "#f8f9fa" }}>
            <tr>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>Club</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>Teams</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>Accepted by</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>Accepted at</th>
              {isAdmin && <th style={{ textAlign: "right", padding: "0.7rem" }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {seasonClubs.map((row) => (
              <tr key={row.id} style={{ borderTop: "1px solid #edf0f2" }}>
                <td style={{ padding: "0.7rem" }}>{row.clubName ?? clubNameById.get(row.clubId) ?? row.clubId}</td>
                <td style={{ padding: "0.7rem" }}>{row.numTeams}</td>
                <td style={{ padding: "0.7rem" }}>{row.acceptedTsCsBy ?? "Not recorded"}</td>
                <td style={{ padding: "0.7rem" }}>{formatDate(row.acceptedTsCsAt)}</td>
                {isAdmin && (
                  <td style={{ padding: "0.7rem", textAlign: "right", display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
                    <button disabled={busy} onClick={() => { void update(row); }} style={btnStyle("#333", "#e9ecef")}>Edit</button>
                    <button disabled={busy} onClick={() => { void remove(row); }} style={btnStyle("#fff", "#dc3545")}>Delete</button>
                  </td>
                )}
              </tr>
            ))}
            {seasonClubs.length === 0 && (
              <tr><td colSpan={isAdmin ? 5 : 4} style={{ padding: "1rem", color: "#6c757d" }}>No clubs registered for this season.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
