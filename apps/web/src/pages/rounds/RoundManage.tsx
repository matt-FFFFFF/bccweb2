/**
 * RoundManage — auth-gated management page for RoundsCoord / Admin.
 *
 * Covers:
 * - Status workflow (Confirm / BriefComplete / Lock / Unlock / Complete)
 * - Metadata editing
 * - Narrative editing
 * - Team management (add / remove)
 * - Pilot slot management (add / remove / accounted-for / sign-to-fly)
 * - Flight logging (log / edit / delete)
 */

import { useState, useCallback, useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  Round,
  RoundStatus,
  Team,
  PilotSlot,
  PilotSummary,
  ClubSummary,
  ScoringType,
} from "@bccweb/types";
import { useBlob } from "../../hooks/useBlob.js";
import { useAuth } from "../../hooks/useAuth.js";
import { api, ApiError } from "../../lib/api.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { LoadingSpinner, ErrorMessage } from "../../components/LoadingSpinner.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function PilotName({
  pilotId,
  index,
}: {
  pilotId: string | null;
  index: PilotSummary[] | null;
}) {
  if (!pilotId) return <span style={{ color: "#aaa" }}>Empty</span>;
  const found = index?.find((p) => p.id === pilotId);
  if (!found)
    return (
      <span style={{ fontFamily: "monospace", fontSize: "0.8em" }}>
        {pilotId}
      </span>
    );
  return (
    <Link
      to={`/pilots/${found.id}`}
      style={{ color: "#0066cc", textDecoration: "none" }}
    >
      {found.name}
    </Link>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #ccc",
  borderRadius: "0.3rem",
  fontSize: "0.875rem",
  boxSizing: "border-box",
};

const btnStyle = (
  color: string,
  bg: string
): React.CSSProperties => ({
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

const sectionStyle: React.CSSProperties = {
  marginBottom: "2rem",
  padding: "1rem",
  border: "1px solid #dee2e6",
  borderRadius: "0.5rem",
};

// ─── Inline error/success banner ─────────────────────────────────────────────

function Banner({ msg, ok }: { msg: string; ok?: boolean }) {
  return (
    <div
      style={{
        padding: "0.5rem 0.75rem",
        borderRadius: "0.35rem",
        marginTop: "0.5rem",
        fontSize: "0.85rem",
        background: ok ? "#d1e7dd" : "#f8d7da",
        color: ok ? "#0a3622" : "#58151c",
      }}
    >
      {msg}
    </div>
  );
}

// ─── Status workflow buttons ──────────────────────────────────────────────────

const WORKFLOW: Record<
  RoundStatus,
  Array<{ label: string; endpoint: string; bg: string; color: string }>
> = {
  Proposed: [
    { label: "Confirm", endpoint: "confirm", bg: "#cfe2ff", color: "#084298" },
  ],
  Confirmed: [
    {
      label: "Mark Brief Complete",
      endpoint: "brief-complete",
      bg: "#d0d0ff",
      color: "#3a00a8",
    },
  ],
  BriefComplete: [
    {
      label: "Lock Round",
      endpoint: "lock",
      bg: "#fff3cd",
      color: "#664d03",
    },
  ],
  Locked: [
    {
      label: "Complete Round",
      endpoint: "complete",
      bg: "#d1e7dd",
      color: "#0a3622",
    },
    {
      label: "Unlock",
      endpoint: "unlock",
      bg: "#e9ecef",
      color: "#495057",
    },
  ],
  Complete: [],
  Cancelled: [],
};

// ─── Add Team form ────────────────────────────────────────────────────────────

function AddTeamForm({
  roundId,
  clubs,
  onAdded,
}: {
  roundId: string;
  clubs: ClubSummary[];
  onAdded: () => void;
}) {
  const [clubId, setClubId] = useState("");
  const [teamName, setTeamName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!clubId || !teamName) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post(`rounds/${roundId}/teams`, { clubId, teamName });
      setClubId("");
      setTeamName("");
      onAdded();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed to add team");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => { void submit(e); }}
      style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem", alignItems: "flex-end" }}
    >
      <div>
        <select
          required
          style={{ ...inputStyle, minWidth: 160 }}
          value={clubId}
          onChange={(e) => setClubId(e.target.value)}
        >
          <option value="">— club —</option>
          {clubs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <input
          required
          placeholder="Team name"
          style={{ ...inputStyle, minWidth: 160 }}
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}
      >
        {busy ? "Adding…" : "Add Team"}
      </button>
      {err && <Banner msg={err} />}
    </form>
  );
}

// ─── Add Pilot form ───────────────────────────────────────────────────────────

function AddPilotForm({
  roundId,
  teamId,
  pilots,
  onAdded,
}: {
  roundId: string;
  teamId: string;
  pilots: PilotSummary[];
  onAdded: () => void;
}) {
  const [pilotId, setPilotId] = useState("");
  const [isScoring, setIsScoring] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pilotId) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post(`rounds/${roundId}/teams/${teamId}/pilots`, {
        pilotId,
        isScoring,
      });
      setPilotId("");
      setIsScoring(true);
      onAdded();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed to add pilot");
    } finally {
      setBusy(false);
    }
  }

  const sortedPilots = [...pilots].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <form
      onSubmit={(e) => { void submit(e); }}
      style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", marginTop: "0.5rem" }}
    >
      <select
        required
        style={{ ...inputStyle, minWidth: 180, flexShrink: 1 }}
        value={pilotId}
        onChange={(e) => setPilotId(e.target.value)}
      >
        <option value="">— pilot —</option>
        {sortedPilots.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <label style={{ display: "flex", gap: "0.3rem", alignItems: "center", fontSize: "0.85rem" }}>
        <input
          type="checkbox"
          checked={isScoring}
          onChange={(e) => setIsScoring(e.target.checked)}
        />
        Scoring
      </label>
      <button
        type="submit"
        disabled={busy}
        style={btnStyle("#fff", busy ? "#6c757d" : "#0a6640")}
      >
        {busy ? "Adding…" : "Add Pilot"}
      </button>
      {err && <Banner msg={err} />}
    </form>
  );
}

// ─── Log/Edit Flight form ─────────────────────────────────────────────────────

interface FlightFormState {
  distance: string;
  url: string;
  duration: string;
  dateTime: string;
  scoringType: ScoringType;
  isFirstXC: boolean;
  isFirstUKXC: boolean;
}

function FlightForm({
  roundId,
  teamId,
  place,
  existing,
  onDone,
  onCancel,
}: {
  roundId: string;
  teamId: string;
  place: number;
  existing?: FlightFormState & { id: string };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FlightFormState>(
    existing ?? {
      distance: "",
      url: "",
      duration: "",
      dateTime: "",
      scoringType: "XC",
      isFirstXC: false,
      isFirstUKXC: false,
    }
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function setF<K extends keyof FlightFormState>(k: K, v: FlightFormState[K]) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.distance) return;
    setBusy(true);
    setErr(null);
    const body = {
      teamId,
      placeInTeam: place,
      distance: Number(form.distance),
      url: form.url || undefined,
      duration: form.duration ? Number(form.duration) : undefined,
      dateTime: form.dateTime || undefined,
      scoringType: form.scoringType,
      isFirstXC: form.isFirstXC,
      isFirstUKXC: form.isFirstUKXC,
    };
    try {
      if (existing) {
        await api.put(`rounds/${roundId}/flights/${existing.id}`, body);
      } else {
        await api.post(`rounds/${roundId}/flights`, body);
      }
      onDone();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed to save flight");
    } finally {
      setBusy(false);
    }
  }

  const fi = { ...inputStyle, width: "100%" };

  return (
    <form
      onSubmit={(e) => { void submit(e); }}
      style={{
        background: "#f8f9fa",
        padding: "0.75rem",
        borderRadius: "0.4rem",
        marginTop: "0.5rem",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
          gap: "0.5rem",
          marginBottom: "0.5rem",
        }}
      >
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Distance (km) *</label>
          <input
            type="number"
            required
            min={0}
            step={0.1}
            style={fi}
            value={form.distance}
            onChange={(e) => setF("distance", e.target.value)}
          />
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Duration (min)</label>
          <input
            type="number"
            min={0}
            style={fi}
            value={form.duration}
            onChange={(e) => setF("duration", e.target.value)}
          />
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Scoring type</label>
          <select
            style={fi}
            value={form.scoringType}
            onChange={(e) => setF("scoringType", e.target.value as ScoringType)}
          >
            <option value="XC">XC</option>
            <option value="Manual">Manual</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Date/time</label>
          <input
            type="datetime-local"
            style={fi}
            value={form.dateTime}
            onChange={(e) => setF("dateTime", e.target.value)}
          />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Flight URL</label>
          <input
            type="url"
            style={fi}
            placeholder="https://…"
            value={form.url}
            onChange={(e) => setF("url", e.target.value)}
          />
        </div>
      </div>
      <div style={{ display: "flex", gap: "1rem", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
        <label style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
          <input
            type="checkbox"
            checked={form.isFirstXC}
            onChange={(e) => setF("isFirstXC", e.target.checked)}
          />
          First XC
        </label>
        <label style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
          <input
            type="checkbox"
            checked={form.isFirstUKXC}
            onChange={(e) => setF("isFirstUKXC", e.target.checked)}
          />
          First UK XC
        </label>
      </div>
      {err && <Banner msg={err} />}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
        <button
          type="submit"
          disabled={busy}
          style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}
        >
          {busy ? "Saving…" : existing ? "Save Changes" : "Log Flight"}
        </button>
        <button
          type="button"
          style={btnStyle("#333", "#e9ecef")}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Pilot slot row ───────────────────────────────────────────────────────────

function PilotRow({
  roundId,
  team,
  slot,
  pilots,
  status,
  onChanged,
}: {
  roundId: string;
  team: Team;
  slot: PilotSlot;
  pilots: PilotSummary[] | null;
  status: RoundStatus;
  onChanged: () => void;
}) {
  const [showFlightForm, setShowFlightForm] = useState(false);
  const [editingFlight, setEditingFlight] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const isLocked = status === "Locked";
  const isComplete = status === "Complete";
  const canFlight = isLocked || isComplete;

  async function toggleField(field: "accounted" | "sign-to-fly", current: boolean) {
    setActionErr(null);
    try {
      await api.put(
        `rounds/${roundId}/teams/${team.id}/pilots/${slot.placeInTeam}/${field}`,
        { value: !current }
      );
      onChanged();
    } catch (ex) {
      setActionErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  async function removePilot() {
    if (!confirm("Remove this pilot slot?")) return;
    setActionErr(null);
    try {
      await api.delete(
        `rounds/${roundId}/teams/${team.id}/pilots/${slot.placeInTeam}`
      );
      onChanged();
    } catch (ex) {
      setActionErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  async function deleteFlight() {
    if (!slot.flight) return;
    if (!confirm("Delete this flight?")) return;
    setActionErr(null);
    try {
      await api.delete(`rounds/${roundId}/flights/${slot.flight.id}`);
      onChanged();
    } catch (ex) {
      setActionErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  const existingFlightForm = slot.flight
    ? {
        id: slot.flight.id,
        distance: String(slot.flight.distance),
        url: slot.flight.url ?? "",
        duration: slot.flight.duration != null ? String(slot.flight.duration) : "",
        dateTime: slot.flight.dateTime
          ? slot.flight.dateTime.slice(0, 16)
          : "",
        scoringType: slot.flight.scoringType,
        isFirstXC: slot.flight.isFirstXC ?? false,
        isFirstUKXC: slot.flight.isFirstUKXC ?? false,
      }
    : undefined;

  return (
    <div
      style={{
        borderBottom: "1px solid #f0f0f0",
        padding: "0.5rem 0",
      }}
    >
      {/* Main row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        {/* Place indicator */}
        <span
          style={{
            width: 22,
            textAlign: "center",
            color: slot.isScoring ? "#333" : "#aaa",
            fontSize: "0.8em",
            flexShrink: 0,
          }}
        >
          {slot.placeInTeam}
        </span>

        {/* Pilot name */}
        <span style={{ flexGrow: 1, minWidth: 120 }}>
          <PilotName pilotId={slot.pilotId} index={pilots} />
          {!slot.isScoring && (
            <span style={{ marginLeft: "0.35rem", fontSize: "0.75em", color: "#888" }}>
              (NS)
            </span>
          )}
        </span>

        {/* Flight summary */}
        {slot.flight && !editingFlight && (
          <span style={{ fontSize: "0.85em", color: "#555" }}>
            {slot.flight.distance} km
            {slot.flight.score > 0 && (
              <span style={{ marginLeft: "0.3rem", fontWeight: 700, color: "#0a3622" }}>
                ({slot.flight.score.toFixed(1)})
              </span>
            )}
          </span>
        )}

        {/* Accounted / sign-to-fly toggles (only when Locked) */}
        {isLocked && slot.status === "Filled" && (
          <>
            <button
              title="Accounted for"
              style={{
                ...btnStyle(
                  slot.accountedFor ? "#0a3622" : "#555",
                  slot.accountedFor ? "#d1e7dd" : "#e9ecef"
                ),
                padding: "0.2rem 0.5rem",
              }}
              onClick={() => { void toggleField("accounted", slot.accountedFor); }}
            >
              {slot.accountedFor ? "✓ Acct" : "Acct"}
            </button>
            <button
              title="Sign to fly"
              style={{
                ...btnStyle(
                  slot.signToFly ? "#664d03" : "#555",
                  slot.signToFly ? "#fff3cd" : "#e9ecef"
                ),
                padding: "0.2rem 0.5rem",
              }}
              onClick={() => { void toggleField("sign-to-fly", slot.signToFly); }}
            >
              {slot.signToFly ? "✓ S2F" : "S2F"}
            </button>
          </>
        )}

        {/* Flight actions */}
        {canFlight && slot.status === "Filled" && (
          <>
            {slot.flight ? (
              <>
                <button
                  style={{ ...btnStyle("#333", "#e9ecef"), padding: "0.2rem 0.5rem" }}
                  onClick={() => { setEditingFlight((v) => !v); setShowFlightForm(false); }}
                >
                  {editingFlight ? "Cancel Edit" : "Edit Flight"}
                </button>
                <button
                  style={{ ...btnStyle("#58151c", "#f8d7da"), padding: "0.2rem 0.5rem" }}
                  onClick={() => { void deleteFlight(); }}
                >
                  Del
                </button>
              </>
            ) : (
              !showFlightForm && (
                <button
                  style={{ ...btnStyle("#fff", "#0a6640"), padding: "0.2rem 0.5rem" }}
                  onClick={() => setShowFlightForm(true)}
                >
                  + Flight
                </button>
              )
            )}
          </>
        )}

        {/* Remove pilot */}
        {!isLocked && !isComplete && slot.status === "Filled" && (
          <button
            style={{ ...btnStyle("#58151c", "#f8d7da"), padding: "0.2rem 0.5rem" }}
            onClick={() => { void removePilot(); }}
          >
            ✕
          </button>
        )}
      </div>

      {actionErr && <Banner msg={actionErr} />}

      {/* Inline flight forms */}
      {showFlightForm && !slot.flight && (
        <FlightForm
          roundId={roundId}
          teamId={team.id}
          place={slot.placeInTeam}
          onDone={() => { setShowFlightForm(false); onChanged(); }}
          onCancel={() => setShowFlightForm(false)}
        />
      )}
      {editingFlight && slot.flight && (
        <FlightForm
          roundId={roundId}
          teamId={team.id}
          place={slot.placeInTeam}
          existing={existingFlightForm}
          onDone={() => { setEditingFlight(false); onChanged(); }}
          onCancel={() => setEditingFlight(false)}
        />
      )}
    </div>
  );
}

// ─── Team card ────────────────────────────────────────────────────────────────

function TeamCard({
  roundId,
  team,
  pilots,
  status,
  onChanged,
}: {
  roundId: string;
  team: Team;
  pilots: PilotSummary[] | null;
  status: RoundStatus;
  onChanged: () => void;
}) {
  const [showAddPilot, setShowAddPilot] = useState(false);
  const [removeErr, setRemoveErr] = useState<string | null>(null);

  const isLocked = status === "Locked";
  const isComplete = status === "Complete";
  const canEdit = !isLocked && !isComplete;

  async function removeTeam() {
    if (!confirm(`Remove team "${team.teamName}"?`)) return;
    setRemoveErr(null);
    try {
      await api.delete(`rounds/${roundId}/teams/${team.id}`);
      onChanged();
    } catch (ex) {
      setRemoveErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  const filledSlots = team.pilots.filter((s) => s.status === "Filled");

  return (
    <div
      style={{
        border: "1px solid #dee2e6",
        borderRadius: "0.5rem",
        overflow: "hidden",
        marginBottom: "1rem",
      }}
    >
      {/* Team header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0.6rem 0.8rem",
          background: "#f8f9fa",
          borderBottom: "1px solid #dee2e6",
        }}
      >
        <div>
          <strong>{team.teamName}</strong>
          <span style={{ marginLeft: "0.5rem", color: "#888", fontSize: "0.85em" }}>
            {team.club.name}
          </span>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {team.score > 0 && (
            <span style={{ fontWeight: 700, color: "#0a3622" }}>
              {team.score.toFixed(1)}
            </span>
          )}
          {canEdit && (
            <button
              style={btnStyle("#58151c", "#f8d7da")}
              onClick={() => { void removeTeam(); }}
            >
              Remove Team
            </button>
          )}
        </div>
      </div>

      {removeErr && <Banner msg={removeErr} />}

      {/* Pilot slots */}
      <div style={{ padding: "0.25rem 0.75rem" }}>
        {filledSlots.map((slot) => (
          <PilotRow
            key={slot.placeInTeam}
            roundId={roundId}
            team={team}
            slot={slot}
            pilots={pilots}
            status={status}
            onChanged={onChanged}
          />
        ))}

        {/* Add pilot */}
        {canEdit && (
          <div style={{ marginTop: "0.5rem", paddingBottom: "0.5rem" }}>
            {showAddPilot ? (
              <AddPilotForm
                roundId={roundId}
                teamId={team.id}
                pilots={pilots ?? []}
                onAdded={() => { setShowAddPilot(false); onChanged(); }}
              />
            ) : (
              <button
                style={btnStyle("#0a6640", "#e8f5e9")}
                onClick={() => setShowAddPilot(true)}
              >
                + Add Pilot
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Metadata edit form ───────────────────────────────────────────────────────

function MetadataForm({
  round,
  onSaved,
}: {
  round: Round;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    maxTeams: String(round.maxTeams),
    minimumScore: String(round.minimumScore),
    briefingTime: round.briefingTime ?? "",
    checkInByTime: round.checkInByTime ?? "",
    landByTime: round.landByTime ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  function setF(k: keyof typeof form, v: string) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      await api.put(`rounds/${round.id}`, {
        maxTeams: Number(form.maxTeams),
        minimumScore: Number(form.minimumScore),
        briefingTime: form.briefingTime || undefined,
        checkInByTime: form.checkInByTime || undefined,
        landByTime: form.landByTime || undefined,
      });
      setOk(true);
      onSaved();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const fi = { ...inputStyle, width: "100%" };

  return (
    <form onSubmit={(e) => { void submit(e); }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <div>
          <label style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>Max Teams</label>
          <input type="number" min={1} style={fi} value={form.maxTeams} onChange={(e) => setF("maxTeams", e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>Min Score</label>
          <input type="number" min={0} step={0.1} style={fi} value={form.minimumScore} onChange={(e) => setF("minimumScore", e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>Briefing</label>
          <input type="time" style={fi} value={form.briefingTime} onChange={(e) => setF("briefingTime", e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>Check-in By</label>
          <input type="time" style={fi} value={form.checkInByTime} onChange={(e) => setF("checkInByTime", e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>Land By</label>
          <input type="time" style={fi} value={form.landByTime} onChange={(e) => setF("landByTime", e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          type="submit"
          disabled={busy}
          style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {ok && <Banner msg="Saved." ok />}
        {err && <Banner msg={err} />}
      </div>
    </form>
  );
}

// ─── Narrative edit form ──────────────────────────────────────────────────────

function NarrativeForm({ round, onSaved }: { round: Round; onSaved: () => void }) {
  const [text, setText] = useState(round.narrative ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      await api.post(`rounds/${round.id}/narrative`, { narrative: text });
      setOk(true);
      onSaved();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => { void submit(e); }}>
      <textarea
        rows={6}
        style={{ ...inputStyle, width: "100%", resize: "vertical" }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="HTML narrative text…"
      />
      <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
        <button
          type="submit"
          disabled={busy}
          style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}
        >
          {busy ? "Saving…" : "Save Narrative"}
        </button>
        {ok && <Banner msg="Saved." ok />}
        {err && <Banner msg={err} />}
      </div>
    </form>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function RoundManage() {
  const { id } = useParams<{ id: string }>();
  const { identity, loading: authLoading } = useAuth();

  const [round, setRound] = useState<Round | null>(null);
  const [roundLoading, setRoundLoading] = useState(true);
  const [roundError, setRoundError] = useState<Error | null>(null);
  const [notFound, setNotFound] = useState(false);

  const { data: pilotsIndex } = useBlob<PilotSummary[]>("pilots.json");
  const { data: clubs } = useBlob<ClubSummary[]>("clubs.json");

  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const loadRound = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.get<Round>(`rounds/${id}`);
      setRound(r);
      setRoundError(null);
      setNotFound(false);
    } catch (err: unknown) {
      setRoundError(err as Error);
      setNotFound(err instanceof ApiError && err.status === 404);
    }
  }, [id]);

  // Initial load
  useEffect(() => {
    if (!id) {
      setRoundLoading(false);
      return;
    }
    let cancelled = false;
    setRoundLoading(true);
    setRoundError(null);
    setNotFound(false);

    api
      .get<Round>(`rounds/${id}`)
      .then((data) => {
        if (!cancelled) {
          setRound(data);
          setRoundLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRoundLoading(false);
          setRoundError(err as Error);
          setNotFound(err instanceof ApiError && err.status === 404);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  async function runAction(label: string, fn: () => Promise<unknown>) {
    setActionErr(null);
    setActionBusy(label);
    try {
      await fn();
      await loadRound();
    } catch (ex) {
      setActionErr(ex instanceof Error ? ex.message : "Action failed");
    } finally {
      setActionBusy(null);
    }
  }

  // Auth gate
  const isCoord =
    identity?.roles.includes("RoundsCoord") ||
    identity?.roles.includes("Admin");

  if (authLoading || roundLoading) return <LoadingSpinner message="Loading…" />;
  if (!identity || !isCoord) {
    return (
      <div style={{ maxWidth: 500, margin: "2rem auto" }}>
        <p style={{ color: "#721c24" }}>
          You must be signed in as a Rounds Coordinator or Admin.
        </p>
      </div>
    );
  }
  if (notFound) return <p>Round not found.</p>;
  if (roundError) return <ErrorMessage error={roundError} title="Could not load round" />;
  if (!round) return null;

  const r = round;
  const workflowActions = WORKFLOW[r.status] ?? [];

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* Breadcrumb */}
      <nav style={{ marginBottom: "1rem", fontSize: "0.85rem", color: "#888" }}>
        <Link to="/rounds" style={{ color: "#0066cc", textDecoration: "none" }}>
          Rounds
        </Link>{" "}
        /{" "}
        <Link to={`/rounds/${r.id}`} style={{ color: "#0066cc", textDecoration: "none" }}>
          {r.site.name}
        </Link>{" "}
        / Manage
      </nav>

      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.75rem", margin: "0 0 0.25rem" }}>
            {r.site.name}
          </h1>
          <p style={{ margin: 0, color: "#555" }}>
            {formatDate(r.date)} — {r.season.year} Season
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.5rem" }}>
          <StatusBadge status={r.status} />
          {(r.status === "Locked" || r.status === "Complete") && (
            <Link
              to={`/rounds/${r.id}/brief`}
              style={{
                padding: "0.35rem 0.75rem",
                background: "#e8edf8",
                color: "#1a4fa0",
                border: "1px solid #c8cce0",
                borderRadius: "0.3rem",
                textDecoration: "none",
                fontSize: "0.82rem",
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              View Brief
            </Link>
          )}
        </div>
      </div>

      {/* Workflow actions */}
      {workflowActions.length > 0 && (
        <div style={{ ...sectionStyle, display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <strong style={{ fontSize: "0.85rem", color: "#555" }}>Actions:</strong>
          {workflowActions.map((a) => (
            <button
              key={a.endpoint}
              disabled={actionBusy !== null}
              style={btnStyle(a.color, a.bg)}
              onClick={() => {
                void runAction(a.label, () =>
                  api.post(`rounds/${r.id}/${a.endpoint}`)
                );
              }}
            >
              {actionBusy === a.label ? "Working…" : a.label}
            </button>
          ))}
          {actionErr && <Banner msg={actionErr} />}
        </div>
      )}

      {/* Metadata */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Round Details</h2>
        {r.isLocked ? (
          <p style={{ color: "#888", fontSize: "0.85rem", margin: 0 }}>
            Unlock the round to edit metadata.
          </p>
        ) : (
          <MetadataForm round={r} onSaved={() => { void loadRound(); }} />
        )}
      </section>

      {/* Narrative */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Narrative</h2>
        <NarrativeForm round={r} onSaved={() => { void loadRound(); }} />
      </section>

      {/* Teams */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
          Teams ({r.teams.length} / {r.maxTeams})
        </h2>

        {r.teams
          .slice()
          .sort((a, b) => a.teamName.localeCompare(b.teamName))
          .map((team) => (
            <TeamCard
              key={team.id}
              roundId={r.id}
              team={team}
              pilots={pilotsIndex}
              status={r.status}
              onChanged={() => { void loadRound(); }}
            />
          ))}

        {/* Add team form — only when not locked/complete */}
        {r.status !== "Locked" && r.status !== "Complete" && r.status !== "Cancelled" && (
          <div style={{ marginTop: "0.5rem" }}>
            <strong style={{ fontSize: "0.85rem" }}>Add Team</strong>
            <AddTeamForm
              roundId={r.id}
              clubs={clubs ?? []}
              onAdded={() => { void loadRound(); }}
            />
          </div>
        )}
      </section>
    </div>
  );
}
