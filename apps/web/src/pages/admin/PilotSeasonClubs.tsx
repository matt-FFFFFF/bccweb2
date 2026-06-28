import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router";
import type { PilotSummary, SeasonClub, ClubSummary } from "@bccweb/types";
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

interface PilotSeasonClubAssignment {
  pilotId: string;
  clubId: string;
  seasonYear: number;
}

export default function PilotSeasonClubs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const yearParam = searchParams.get("year");
  const seasonYear = yearParam ? Number.parseInt(yearParam, 10) : new Date().getFullYear();

  const { identity, loading: authLoading } = useAuth();
  const { data: pilotsList, loading: pilotsLoading } = useBlob<PilotSummary[]>("pilots.json");
  const { data: clubsList, loading: clubsLoading } = useBlob<ClubSummary[]>("clubs.json");

  const [assignments, setAssignments] = useState<PilotSeasonClubAssignment[]>([]);
  const [seasonClubs, setSeasonClubs] = useState<SeasonClub[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [msg, setMsg] = useState<{ text: string, ok: boolean } | null>(null);
  
  const [showAssign, setShowAssign] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedPilotId, setSelectedPilotId] = useState("");
  const [selectedClubId, setSelectedClubId] = useState("");
  const [reassignFlag, setReassignFlag] = useState(false);

  const isAdmin = identity?.roles.includes("Admin");
  const canRead = isAdmin || identity?.roles.includes("RoundsCoord");

  const pilotNameById = useMemo(() => new Map((pilotsList ?? []).map((p) => [p.id, p.name])), [pilotsList]);
  const clubNameById = useMemo(() => new Map((clubsList ?? []).map((c) => [c.id, c.name])), [clubsList]);

  async function load() {
    if (!Number.isInteger(seasonYear)) return;
    setLoading(true);
    try {
      const [assigns, sClubs] = await Promise.all([
        api.get<PilotSeasonClubAssignment[]>(`manage/pilot-season-clubs?year=${seasonYear}`),
        api.get<SeasonClub[]>(`manage/seasons/${seasonYear}/clubs`)
      ]);
      setAssignments(assigns);
      setSeasonClubs(sClubs);
    } catch (ex) {
      setMsg({ text: ex instanceof Error ? ex.message : "Failed to load", ok: false });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!authLoading && !pilotsLoading && !clubsLoading && canRead) {
      void load();
    }
  }, [authLoading, pilotsLoading, clubsLoading, canRead, seasonYear]);

  async function handleAssign(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`manage/pilot-season-clubs${reassignFlag ? "?reassign=true" : ""}`, {
        pilotId: selectedPilotId,
        clubId: selectedClubId,
        seasonYear
      });
      setMsg({ text: "Pilot assigned.", ok: true });
      setShowAssign(false);
      setSelectedPilotId("");
      setSelectedClubId("");
      setReassignFlag(false);
      await load();
    } catch (ex) {
      if (ex && typeof ex === 'object' && 'code' in ex && ex.code === "PILOT_ALREADY_ASSIGNED") {
        setMsg({ text: "Pilot is already assigned to a different club this season. Use 'Replace existing' to reassign.", ok: false });
        setReassignFlag(true);
      } else {
        setMsg({ text: ex instanceof Error ? ex.message : "Failed to assign pilot", ok: false });
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(pilotId: string, pName: string) {
    if (!window.confirm(`Remove ${pName} from season ${seasonYear}?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.delete(`manage/pilot-season-clubs/${pilotId}/${seasonYear}`);
      setMsg({ text: "Assignment removed.", ok: true });
      await load();
    } catch (ex) {
      setMsg({ text: ex instanceof Error ? ex.message : "Failed to remove assignment", ok: false });
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || pilotsLoading || clubsLoading || loading) return <LoadingSpinner message="Loading..." />;
  if (!canRead) return <p style={{ color: "#721c24" }}>Admin or Rounds Coordinator access required.</p>;

  // Filter pilots that aren't already assigned (unless reassign is shown)
  const assignedPilotIds = new Set(assignments.map(a => a.pilotId));
  const availablePilots = (pilotsList ?? []).filter(p => reassignFlag || !assignedPilotIds.has(p.id));

  // For RoundsCoord, restrict club selection to their own club
  const availableClubs = seasonClubs.filter(sc => isAdmin || sc.clubId === identity?.clubId);

  return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", marginBottom: "1.25rem", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: "1.55rem", margin: 0 }}>Pilot Season Clubs</h1>
          <p style={{ margin: "0.35rem 0 0", color: "#6c757d" }}>Assign pilots to clubs for the season.</p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
          <select 
            value={seasonYear} 
            onChange={(e) => setSearchParams({ year: e.target.value })}
            style={{ ...inputStyle, padding: "0.45rem" }}
          >
            {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i).map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <button onClick={() => { setShowAssign(true); setReassignFlag(false); setMsg(null); }} style={btnStyle("#fff", "#0a6640")}>Assign Pilot</button>
        </div>
      </div>

      {msg && <div style={{ marginBottom: "1rem" }}><Banner msg={msg.text} ok={msg.ok} /></div>}

      {showAssign && (
        <form onSubmit={(e) => { void handleAssign(e); }} style={{ padding: "1rem", border: "1px solid #d9e2ea", borderRadius: "0.75rem", marginBottom: "1rem", background: "#fbfcfd", display: "grid", gap: "0.75rem" }}>
          <strong>Assign Pilot ({seasonYear})</strong>
          <select aria-label="Pilot" required value={selectedPilotId} onChange={(e) => setSelectedPilotId(e.target.value)} style={inputStyle}>
            <option value="">Select pilot</option>
            {availablePilots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select aria-label="Club" required value={selectedClubId} onChange={(e) => setSelectedClubId(e.target.value)} style={inputStyle}>
            <option value="">Select registered club</option>
            {availableClubs.map((sc) => <option key={sc.clubId} value={sc.clubId}>{clubNameById.get(sc.clubId) ?? sc.clubId}</option>)}
          </select>
          {reassignFlag && (
             <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", color: "#856404", background: "#fff3cd", padding: "0.5rem", borderRadius: "0.25rem" }}>
               <input type="checkbox" checked={reassignFlag} onChange={(e) => setReassignFlag(e.target.checked)} required />
               Replace existing assignment for this pilot
             </label>
          )}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="submit" disabled={busy || !selectedPilotId || !selectedClubId} style={btnStyle("#fff", busy ? "#6c757d" : "#0a6640")}>{busy ? "Submitting…" : "Submit"}</button>
            <button type="button" onClick={() => setShowAssign(false)} style={btnStyle("#333", "#e9ecef")}>Cancel</button>
          </div>
        </form>
      )}

      <div style={{ overflowX: "auto", border: "1px solid #dee2e6", borderRadius: "0.6rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead style={{ background: "#f8f9fa" }}>
            <tr>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>Pilot</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>Club</th>
              <th style={{ textAlign: "right", padding: "0.7rem" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((row) => {
              const pName = pilotNameById.get(row.pilotId) ?? row.pilotId;
              return (
              <tr key={`${row.pilotId}-${row.clubId}`} style={{ borderTop: "1px solid #edf0f2" }}>
                <td style={{ padding: "0.7rem" }}>{pName}</td>
                <td style={{ padding: "0.7rem" }}>{clubNameById.get(row.clubId) ?? row.clubId}</td>
                <td style={{ padding: "0.7rem", textAlign: "right" }}>
                  <button disabled={busy} onClick={() => { void remove(row.pilotId, pName); }} style={btnStyle("#fff", "#dc3545")}>Remove</button>
                </td>
              </tr>
            )})}
            {assignments.length === 0 && (
              <tr><td colSpan={3} style={{ padding: "1rem", color: "#6c757d" }}>No pilots assigned to clubs for this season.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
