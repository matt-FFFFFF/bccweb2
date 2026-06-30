import { useState, useRef, useEffect } from "react";
import type { Club, ClubSummary, ClubTeam, ClubTeamSummary, SeasonSummary } from "@bccweb/types";
import { useAuth } from "../../hooks/useAuth.js";
import { api } from "../../lib/api.js";
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

// ─── Team row (rename + delete) ───────────────────────────────────────────────

function TeamRow({
  team,
  onSaved,
  onDeleted,
}: {
  team: ClubTeamSummary;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(team.teamName);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.put<ClubTeam>(`club-teams/${team.id}`, { teamName: name });
      setMsg("Saved.");
      setMsgOk(true);
      setEditing(false);
      onSaved();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete team "${team.teamName}"?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.deleteJson<{ id: string }>(`club-teams/${team.id}`);
      onDeleted();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed");
      setMsgOk(false);
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", padding: "0.35rem 0", borderBottom: "1px solid #f5f5f5" }}>
      {editing ? (
        <form onSubmit={(e) => { void save(e); }} style={{ display: "flex", gap: "0.5rem", alignItems: "center", flex: 1, flexWrap: "wrap" }}>
          <input
            required
            style={{ ...inputStyle, minWidth: 160, flex: 1 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => { setEditing(false); setName(team.teamName); }} style={btnStyle("#333", "#e9ecef")}>
            Cancel
          </button>
          {msg && <Banner msg={msg} ok={msgOk} />}
        </form>
      ) : (
        <>
          <span style={{ flex: 1, fontSize: "0.875rem" }}>{team.teamName}</span>
          <button onClick={() => setEditing(true)} style={btnStyle("#333", "#e9ecef")} disabled={busy}>Rename</button>
          <button onClick={() => { void remove(); }} style={btnStyle("#fff", "#dc3545")} disabled={busy}>Delete</button>
          {msg && <Banner msg={msg} ok={msgOk} />}
        </>
      )}
    </div>
  );
}

// ─── Add team form ────────────────────────────────────────────────────────────

function AddTeamForm({
  clubId,
  seasonYear,
  onCreated,
}: {
  clubId: string;
  seasonYear: number;
  onCreated: () => void;
}) {
  const [teamName, setTeamName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.post<ClubTeam>("club-teams", { clubId, seasonYear, teamName });
      setTeamName("");
      setMsg("Team added.");
      setMsgOk(true);
      onCreated();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => { void submit(e); }}
      style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.5rem" }}
    >
      <input
        required
        placeholder="New team name"
        style={{ ...inputStyle, minWidth: 160, flex: 1 }}
        value={teamName}
        onChange={(e) => setTeamName(e.target.value)}
      />
      <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0a6640")}>
        {busy ? "Adding…" : "Add Team"}
      </button>
      {msg && <Banner msg={msg} ok={msgOk} />}
    </form>
  );
}

// ─── Club card with teams section ─────────────────────────────────────────────

function ClubCard({
  club,
  teams,
  activeSeasonYear,
  onClubSaved,
  onTeamChanged,
}: {
  club: ClubSummary;
  teams: ClubTeamSummary[];
  activeSeasonYear: number | null;
  onClubSaved: () => void;
  onTeamChanged: () => void;
}) {
  const [name, setName] = useState(club.name);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);

  // Season selector — default to active season
  const seasonYears = Array.from(new Set(teams.map((t) => t.seasonYear))).sort((a, b) => b - a);
  if (activeSeasonYear && !seasonYears.includes(activeSeasonYear)) {
    seasonYears.unshift(activeSeasonYear);
  }
  const [selectedYear, setSelectedYear] = useState<number | null>(activeSeasonYear);
  const filteredTeams = selectedYear ? teams.filter((t) => t.seasonYear === selectedYear) : [];

  async function saveClub(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.put<Club>(`clubs/${club.id}`, { name });
      setMsg("Saved.");
      setMsgOk(true);
      onClubSaved();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", marginBottom: "0.75rem", overflow: "hidden" }}>
      {/* Club header row */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 0.75rem", background: "#f8f9fa", flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.7rem", color: "#aaa", fontFamily: "monospace", minWidth: 72 }}>{club.id.slice(0, 8)}…</span>
        <form onSubmit={(e) => { void saveClub(e); }} style={{ display: "flex", gap: "0.5rem", alignItems: "center", flex: 1, flexWrap: "wrap" }}>
          <input
            required
            style={{ ...inputStyle, minWidth: 180, flex: 1 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}>
            {busy ? "Saving…" : "Save"}
          </button>
          {msg && <Banner msg={msg} ok={msgOk} />}
        </form>
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{ ...btnStyle("#333", "#e9ecef"), marginLeft: "auto" }}
        >
          {expanded ? "Hide Teams" : `Teams (${teams.length})`}
        </button>
      </div>

      {/* Teams panel */}
      {expanded && (
        <div style={{ padding: "0.75rem 1rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "0.85rem" }}>Season:</strong>
            <select
              style={{ ...inputStyle }}
              value={selectedYear ?? ""}
              onChange={(e) => setSelectedYear(e.target.value ? parseInt(e.target.value, 10) : null)}
            >
              {seasonYears.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
              {seasonYears.length === 0 && <option value="">No seasons</option>}
            </select>
          </div>

          {filteredTeams.length === 0 ? (
            <p style={{ fontSize: "0.8rem", color: "#888", margin: "0 0 0.5rem" }}>No teams for this season.</p>
          ) : (
            filteredTeams.map((t) => (
              <TeamRow key={t.id} team={t} onSaved={onTeamChanged} onDeleted={onTeamChanged} />
            ))
          )}

          {selectedYear && (
            <AddTeamForm
              clubId={club.id}
              seasonYear={selectedYear}
              onCreated={onTeamChanged}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Create club form ─────────────────────────────────────────────────────────

function CreateClubForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.post<Club>("clubs", { name });
      setName("");
      setMsg("Club created.");
      setMsgOk(true);
      onCreated();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => { void submit(e); }}
      style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginTop: "1.25rem", paddingTop: "1rem", borderTop: "2px solid #dee2e6" }}
    >
      <strong style={{ fontSize: "0.85rem" }}>New Club</strong>
      <input
        required
        placeholder="Club name"
        style={{ ...inputStyle, minWidth: 200, flex: 1 }}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0a6640")}>
        {busy ? "Creating…" : "Create"}
      </button>
      {msg && <Banner msg={msg} ok={msgOk} />}
    </form>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminClubs() {
  const { identity, loading: authLoading } = useAuth();
  const [clubsRefresh, setClubsRefresh] = useState(0);
  const [teamsRefresh, setTeamsRefresh] = useState(0);

  const { data: clubs, loading: clubsLoading } = useBlob<ClubSummary[]>(`clubs.json?v=${clubsRefresh}`);
  const { data: seasons, loading: seasonsLoading } = useBlob<SeasonSummary[]>("seasons.json");
  const { data: allTeams, loading: teamsLoading } = useBlob<ClubTeamSummary[]>(`club-teams.json?v=${teamsRefresh}`);

  const clubsRef = useRef<ClubSummary[]>([]);
  const teamsRef = useRef<ClubTeamSummary[]>([]);
  if (clubs) clubsRef.current = clubs;
  if (allTeams) teamsRef.current = allTeams;

  const [loadedOnce, setLoadedOnce] = useState(false);
  useEffect(() => { if (clubs && seasons && allTeams) setLoadedOnce(true); }, [clubs, seasons, allTeams]);

  const isAdmin = identity?.roles.includes("Admin");

  const activeSeasonYear = seasons ? (seasons.find((s) => s.active) ?? seasons[seasons.length - 1])?.year ?? null : null;

  if (authLoading || (!loadedOnce && (clubsLoading || seasonsLoading || teamsLoading))) {
    return <LoadingSpinner message="Loading clubs…" />;
  }
  if (!isAdmin) return <p style={{ color: "#721c24" }}>Admin access required.</p>;

  const clubList = clubs ?? clubsRef.current;
  const teamIndex = allTeams ?? teamsRef.current;

  const refreshClubs = () => setClubsRefresh((v) => v + 1);
  const refreshTeams = () => setTeamsRefresh((v) => v + 1);

  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Clubs</h1>

      {clubList.map((c) => (
        <ClubCard
          key={c.id}
          club={c}
          teams={teamIndex.filter((t) => t.clubId === c.id)}
          activeSeasonYear={activeSeasonYear}
          onClubSaved={refreshClubs}
          onTeamChanged={refreshTeams}
        />
      ))}

      <CreateClubForm onCreated={refreshClubs} />
    </div>
  );
}
