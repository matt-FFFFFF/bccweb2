/**
 * MyClub — self-service page for RoundsCoord users to manage their club's
 * teams for the active season.
 *
 * Route: /club
 * Visible to: RoundsCoord (and Admin, though Admins typically use /admin/clubs)
 *
 * Teams are fetched via the authenticated API endpoint (GET /api/club-teams)
 * filtered to the caller's club and the active season only — not via the
 * public blob, which would expose all clubs' data unnecessarily.
 */

import { useCallback, useEffect, useState } from "react";
import * as z from "zod/v4";
import type { ClubSummary, ClubTeam, ClubTeamSummary, SeasonSummary } from "@bccweb/types";
import { ClubSummarySchema, SeasonSummarySchema } from "@bccweb/schemas";
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

// ─── Team row ─────────────────────────────────────────────────────────────────

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
    <div style={{
      display: "flex",
      gap: "0.5rem",
      alignItems: "center",
      flexWrap: "wrap",
      padding: "0.5rem 0",
      borderBottom: "1px solid #f0f0f0",
    }}>
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
          <button
            type="button"
            onClick={() => { setEditing(false); setName(team.teamName); }}
            style={btnStyle("#333", "#e9ecef")}
          >
            Cancel
          </button>
          {msg && <Banner msg={msg} ok={msgOk} />}
        </form>
      ) : (
        <>
          <span style={{ flex: 1, fontSize: "0.9rem" }}>{team.teamName}</span>
          <button onClick={() => setEditing(true)} style={btnStyle("#333", "#e9ecef")} disabled={busy}>
            Rename
          </button>
          <button onClick={() => { void remove(); }} style={btnStyle("#fff", "#dc3545")} disabled={busy}>
            Delete
          </button>
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
      style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.75rem" }}
    >
      <input
        required
        placeholder="New team name"
        style={{ ...inputStyle, minWidth: 180, flex: 1 }}
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MyClub() {
  const { identity, loading: authLoading } = useAuth();

  // Public blobs — seasons (to find the active year) and clubs (for the club name)
  const { data: seasons, loading: seasonsLoading } = useBlob<SeasonSummary[]>("seasons.json", z.array(SeasonSummarySchema));
  const { data: clubs, loading: clubsLoading } = useBlob<ClubSummary[]>("clubs.json", z.array(ClubSummarySchema));

  // Teams for this club+season fetched via the authenticated API
  const [myTeams, setMyTeams] = useState<ClubTeamSummary[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamsError, setTeamsError] = useState<string | null>(null);

  const isCoord = identity?.roles.includes("RoundsCoord") || identity?.roles.includes("Admin");
  const clubId = identity?.clubId ?? null;

  const activeSeasonYear = seasons
    ? (seasons.find((s) => s.active) ?? seasons[seasons.length - 1])?.year ?? null
    : null;

  const loadTeams = useCallback(async () => {
    if (!clubId || !activeSeasonYear) return;
    setTeamsLoading(true);
    setTeamsError(null);
    try {
      const data = await api.get<ClubTeamSummary[]>(
        `club-teams?clubId=${encodeURIComponent(clubId)}&seasonYear=${activeSeasonYear}`
      );
      setMyTeams(data);
    } catch (ex) {
      setTeamsError(ex instanceof Error ? ex.message : "Failed to load teams");
    } finally {
      setTeamsLoading(false);
    }
  }, [clubId, activeSeasonYear]);

  useEffect(() => {
    if (isCoord && clubId && activeSeasonYear) {
      void loadTeams();
    }
  }, [isCoord, clubId, activeSeasonYear, loadTeams]);

  if (authLoading || seasonsLoading || clubsLoading) {
    return <LoadingSpinner message="Loading club…" />;
  }

  if (!isCoord) {
    return <p style={{ color: "#721c24" }}>You need the RoundsCoord role to access this page.</p>;
  }

  if (!clubId) {
    return (
      <div style={{ maxWidth: 600, margin: "0 auto" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>My Club</h1>
        <p style={{ color: "#856404", background: "#fff3cd", padding: "0.75rem 1rem", borderRadius: "0.4rem", fontSize: "0.9rem" }}>
          Your account is not assigned to a club yet. Ask an Admin to assign you to a club in User Management.
        </p>
      </div>
    );
  }

  const club = clubs?.find((c) => c.id === clubId);

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>My Club</h1>

      <div style={{ marginBottom: "1.5rem" }}>
        <span style={{ fontSize: "1.15rem", fontWeight: 600 }}>{club?.name ?? clubId}</span>
        {activeSeasonYear && (
          <span style={{ marginLeft: "0.75rem", fontSize: "0.85rem", color: "#555" }}>
            — {activeSeasonYear} season
          </span>
        )}
      </div>

      {!activeSeasonYear ? (
        <p style={{ color: "#888", fontSize: "0.9rem" }}>No active season found.</p>
      ) : (
        <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "0.75rem 1rem" }}>
          <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem", marginTop: 0 }}>
            Teams — {activeSeasonYear}
          </h2>

          {teamsLoading ? (
            <LoadingSpinner message="Loading teams…" />
          ) : teamsError ? (
            <Banner msg={teamsError} />
          ) : myTeams.length === 0 ? (
            <p style={{ fontSize: "0.875rem", color: "#888", margin: "0 0 0.25rem" }}>
              No teams registered for this season yet.
            </p>
          ) : (
            myTeams.map((t) => (
              <TeamRow key={t.id} team={t} onSaved={() => { void loadTeams(); }} onDeleted={() => { void loadTeams(); }} />
            ))
          )}

          <AddTeamForm clubId={clubId} seasonYear={activeSeasonYear} onCreated={() => { void loadTeams(); }} />
        </div>
      )}
    </div>
  );
}
