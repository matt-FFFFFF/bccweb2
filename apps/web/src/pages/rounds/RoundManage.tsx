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
import { Link, useParams } from "react-router";
import type {
  Round,
  RoundStatus,
  Team,
  PilotSlot,
  PilotSummary,
  ClubSummary,
  ClubTeamSummary,
  ScoringType,
  Signature,
  RoundBrief,
  Pilot,
  CoachType,
} from "@bccweb/types";
import { COACH_TYPES, coachLabel } from "../../lib/coach.js";
import { MarkdownEditor } from "../../components/MarkdownEditor.js";
import { MarkdownView } from "../../components/MarkdownView.js";
import { AuthImage } from "../../components/AuthImage.js";
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

function pilotDisplayName(pilotId: string | null, index: PilotSummary[] | null): string {
  if (!pilotId) return "Empty";
  return index?.find((p) => p.id === pilotId)?.name ?? pilotId;
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
  Array<{ label: string; endpoint: string; bg: string; color: string; requiresConfirm?: boolean }>
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
      requiresConfirm: true,
    },
  ],
  BriefComplete: [
    {
      label: "Lock Round",
      endpoint: "lock",
      bg: "#fff3cd",
      color: "#664d03",
    },
    {
      label: "Reopen Brief",
      endpoint: "reopen",
      bg: "#e9ecef",
      color: "#495057",
      requiresConfirm: true,
    }
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
  clubTeams,
  seasonYear,
  existingTeams,
  onAdded,
  lockedClubId,
}: {
  roundId: string;
  clubs: ClubSummary[];
  clubTeams: ClubTeamSummary[];
  seasonYear: number;
  existingTeams: Team[];
  onAdded: () => void;
  lockedClubId?: string | null;
}) {
  const [clubIdState, setClubIdState] = useState("");
  const clubId = lockedClubId ?? clubIdState;
  const [teamName, setTeamName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const availableTeams = clubId
    ? clubTeams
        .filter(
          (t) =>
            t.clubId === clubId &&
            t.seasonYear === seasonYear &&
            !existingTeams.some(
              (et) =>
                et.club.id === t.clubId &&
                et.teamName.toLowerCase() === t.teamName.toLowerCase()
            )
        )
        .slice()
        .sort((a, b) => a.teamName.localeCompare(b.teamName))
    : [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!clubId || !teamName) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post(`rounds/${roundId}/teams`, { clubId, teamName });
      setClubIdState("");
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
      {!lockedClubId && (
        <div>
          <select
            required
            style={{ ...inputStyle, minWidth: 160 }}
            value={clubIdState}
            onChange={(e) => {
              setClubIdState(e.target.value);
              setTeamName("");
            }}
          >
            <option value="">— club —</option>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <select
          required
          style={{ ...inputStyle, minWidth: 160 }}
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
          disabled={!clubId || availableTeams.length === 0}
        >
          <option value="">
            {!clubId
              ? "— pick a club first —"
              : availableTeams.length === 0
                ? "— no teams available —"
                : "— team —"}
          </option>
          {availableTeams.map((t) => (
            <option key={t.id} value={t.teamName}>
              {t.teamName}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={busy || !clubId || !teamName}
        style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}
      >
        {busy ? "Adding…" : "Add Team"}
      </button>
      {clubId && availableTeams.length === 0 && (
        <span style={{ fontSize: "0.75rem", color: "#888" }}>
          No unassigned teams for this club in {seasonYear}. Register more under Club Teams.
        </span>
      )}
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
  canOverrideSign,
  canManage,
  canEditTeam,
  onChanged,
}: {
  roundId: string;
  team: Team;
  slot: PilotSlot;
  pilots: PilotSummary[] | null;
  status: RoundStatus;
  canOverrideSign: boolean;
  canManage: boolean;
  canEditTeam: boolean;
  onChanged: () => void;
}) {
  const [showFlightForm, setShowFlightForm] = useState(false);
  const [editingFlight, setEditingFlight] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideErr, setOverrideErr] = useState<string | null>(null);
  const [overrideBusy, setOverrideBusy] = useState(false);

  const isLocked = status === "Locked";
  const isComplete = status === "Complete";
  const canFlight = isLocked;

  async function toggleAccounted(current: boolean) {
    setActionErr(null);
    try {
      await api.put(
        `rounds/${roundId}/teams/${team.id}/pilots/${slot.placeInTeam}/accounted`,
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

  async function submitOverride(e: React.FormEvent) {
    e.preventDefault();
    if (!slot.pilotId || overrideReason.trim().length < 20) return;
    setOverrideBusy(true);
    setOverrideErr(null);
    setActionOk(null);
    try {
      await api.post<Signature>(
        `rounds/${roundId}/teams/${team.id}/pilots/${slot.placeInTeam}/sign-override`,
        { reason: overrideReason, onBehalfOfPilotId: slot.pilotId }
      );
      setOverrideOpen(false);
      setOverrideReason("");
      setActionOk("Override signature recorded.");
      onChanged();
    } catch (ex) {
      if (ex instanceof ApiError && ex.code === "INVALID_REASON") {
        setOverrideErr(ex.detail ?? ex.message);
      } else {
        setOverrideErr(ex instanceof Error ? ex.message : "Failed to record override signature");
      }
    } finally {
      setOverrideBusy(false);
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

        {/* Accounted-for toggle (only when Locked) */}
        {canManage && isLocked && slot.status === "Filled" && (
          <button
            title="Accounted for"
            style={{
              ...btnStyle(
                slot.accountedFor ? "#0a3622" : "#555",
                slot.accountedFor ? "#d1e7dd" : "#e9ecef"
              ),
              padding: "0.2rem 0.5rem",
            }}
            onClick={() => { void toggleAccounted(slot.accountedFor); }}
          >
            {slot.accountedFor ? "✓ Acct" : "Acct"}
          </button>
        )}

        {/* Flight actions */}
        {canManage && canFlight && slot.status === "Filled" && (
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

        {canOverrideSign && status === "BriefComplete" && slot.status === "Filled" && slot.pilotId && (
          <button
            style={{ ...btnStyle("#5f3b00", "#fff3cd"), padding: "0.2rem 0.5rem" }}
            onClick={() => { setOverrideOpen(true); setOverrideErr(null); }}
          >
            Override Sign
          </button>
        )}

        {/* Remove pilot */}
        {canEditTeam && !isLocked && !isComplete && slot.status === "Filled" && (
          <button
            style={{ ...btnStyle("#58151c", "#f8d7da"), padding: "0.2rem 0.5rem" }}
            onClick={() => { void removePilot(); }}
          >
            ✕
          </button>
        )}
      </div>

      {actionOk && <Banner msg={actionOk} ok />}
      {actionErr && <Banner msg={actionErr} />}

      {overrideOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`override-title-${team.id}-${slot.placeInTeam}`}
          style={{
            marginTop: "0.75rem",
            padding: "0.85rem",
            border: "1px solid #f0c36d",
            borderRadius: "0.5rem",
            background: "#fffaf0",
          }}
        >
          <h3 id={`override-title-${team.id}-${slot.placeInTeam}`} style={{ margin: "0 0 0.5rem", fontSize: "1rem" }}>
            Override Sign: {pilotDisplayName(slot.pilotId, pilots)}
          </h3>
          <p style={{ margin: "0 0 0.5rem", color: "#664d03", fontSize: "0.85rem" }}>
            {team.teamName}, place {slot.placeInTeam}. This will record a coord-override signature on the immutable ledger. The pilot's own sign-to-fly remains preferred; this is for documented exceptions only.
          </p>
          <form onSubmit={(e) => { void submitOverride(e); }}>
            <label style={{ display: "block", fontSize: "0.8rem", color: "#555", marginBottom: "0.25rem" }}>
              Reason (minimum 20 characters)
            </label>
            <textarea
              required
              minLength={20}
              rows={4}
              style={{ ...inputStyle, width: "100%", resize: "vertical" }}
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
            />
            {overrideErr && <Banner msg={overrideErr} />}
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
              <button
                type="submit"
                disabled={overrideBusy || overrideReason.trim().length < 20}
                style={btnStyle("#fff", overrideBusy || overrideReason.trim().length < 20 ? "#6c757d" : "#8a5a00")}
              >
                {overrideBusy ? "Recording…" : "Submit Override"}
              </button>
              <button
                type="button"
                disabled={overrideBusy}
                style={btnStyle("#333", "#e9ecef")}
                onClick={() => setOverrideOpen(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

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

function ChangeCaptainSelect({
  roundId,
  team,
  pilots,
  onChanged,
}: {
  roundId: string;
  team: Team;
  pilots: PilotSummary[] | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const filledPilots = team.pilots
    .filter((s) => s.status === "Filled" && s.pilotId !== null)
    .sort((a, b) => a.placeInTeam - b.placeInTeam);

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newPilotId = e.target.value || null;
    setBusy(true);
    setErr(null);
    try {
      await api.put(`rounds/${roundId}/teams/${team.id}/captain`, {
        pilotId: newPilotId,
      });
      onChanged();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed to update captain");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginTop: "0.25rem" }}>
      <label style={{ fontSize: "0.75rem", color: "#555", whiteSpace: "nowrap" }}>
        Captain:
      </label>
      <select
        style={{ ...inputStyle, fontSize: "0.78rem", padding: "0.2rem 0.35rem" }}
        value={team.captainPilotId ?? ""}
        disabled={busy}
        onChange={(e) => { void handleChange(e); }}
      >
        <option value="">— none —</option>
        {filledPilots.map((s) => (
          <option key={s.pilotId} value={s.pilotId!}>
            {pilotDisplayName(s.pilotId, pilots)}
          </option>
        ))}
      </select>
      {err && (
        <span style={{ fontSize: "0.75rem", color: "#721c24" }}>{err}</span>
      )}
    </div>
  );
}

function TeamCard({
  roundId,
  team,
  pilots,
  status,
  canOverrideSign,
  canManage,
  canManageCaptain,
  canEditTeam,
  onChanged,
}: {
  roundId: string;
  team: Team;
  pilots: PilotSummary[] | null;
  status: RoundStatus;
  canOverrideSign: boolean;
  canManage: boolean;
  canManageCaptain: boolean;
  canEditTeam: boolean;
  onChanged: () => void;
}) {
  const [showAddPilot, setShowAddPilot] = useState(false);
  const [removeErr, setRemoveErr] = useState<string | null>(null);

  const isLocked = status === "Locked";
  const isComplete = status === "Complete";
  const canEdit = !isLocked && !isComplete && canEditTeam;

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
          {canManageCaptain ? (
            <ChangeCaptainSelect
              roundId={roundId}
              team={team}
              pilots={pilots}
              onChanged={onChanged}
            />
          ) : (
            <div style={{ fontSize: "0.78rem", color: "#555", marginTop: "0.2rem" }}>
              Captain:{" "}
              <strong>
                {team.captainPilotId
                  ? pilotDisplayName(team.captainPilotId, pilots)
                  : "—"}
              </strong>
            </div>
          )}
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
            canOverrideSign={canOverrideSign}
            canManage={canManage}
            canEditTeam={canEditTeam}
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


// ─── Brief edit form ─────────────────────────────────────────────────────────

function MarkdownBriefField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>{label}</label>
      <div style={{ border: "1px solid #ccc", padding: "0.5rem" }}>
        {disabled ? (
          <div style={{ opacity: 0.6 }}>
            <MarkdownView markdown={value} />
          </div>
        ) : (
          <>
            <MarkdownEditor value={value} onChange={v => onChange(v ?? "")} preview="edit" />
            <div style={{ marginTop: "0.5rem", borderTop: "1px solid #eee", paddingTop: "0.5rem" }}>
              <div style={{ fontSize: "0.75rem", color: "#888", marginBottom: "0.25rem" }}>Preview</div>
              <MarkdownView markdown={value} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BriefForm({ round, onSaved }: { round: Round; onSaved: () => void }) {
  const { identity } = useAuth();
  const [brief, setBrief] = useState<Partial<RoundBrief> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let active = true;
    const editable = round.status === "Proposed" || round.status === "Confirmed";

    async function load() {
      let loaded: Partial<RoundBrief>;
      try {
        loaded = await api.get<RoundBrief>(`rounds/${round.id}/brief`);
      } catch {
        loaded = {};
      }

      if (editable && !loaded.briefer?.name && identity?.pilotId) {
        try {
          const me = await api.get<Pilot>(`pilots/${identity.pilotId}`);
          loaded = {
            ...loaded,
            briefer: {
              name: me.person?.fullName || undefined,
              bhpaCoachLevel: me.coachType !== "None" ? me.coachType : undefined,
              bhpaNumber: me.bhpaNumber != null ? String(me.bhpaNumber) : undefined,
              phoneNumber: me.person?.phoneNumber || undefined,
              emailAddress: identity.email || undefined,
            },
          };
        } catch {
          // best-effort: no linked pilot profile, leave the briefer blank
        }
      }

      if (active) {
        setBrief(loaded);
        setLoading(false);
      }
    }

    void load();
    return () => { active = false; };
  }, [round.id, round.status, identity?.pilotId, identity?.email]);

  if (loading) return <div>Loading brief...</div>;

  const disabled = round.status === "BriefComplete" || round.status === "Locked" || round.status === "Complete";

  const handleChange = <K extends keyof RoundBrief>(field: K, value: RoundBrief[K]) => {
    setBrief(prev => ({ ...prev, [field]: value }));
  };

  const handleBrieferChange = (field: keyof NonNullable<RoundBrief["briefer"]>, value: string | undefined) => {
    setBrief(prev => ({
      ...prev,
      briefer: { ...(prev?.briefer || {}), [field]: value || undefined } as RoundBrief["briefer"],
    }));
  };

  const submit = async () => {
    setSaving(true);
    setErr(null);
    setOk(false);
    try {
      await api.put(`rounds/${round.id}/brief`, brief);
      setOk(true);
      onSaved();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  const uploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setErr("Image > 5MB"); return; }
    
    const token = localStorage.getItem("bcc_access_token");
    const fd = new FormData();
    fd.append("file", file);

    try {
      const res = await fetch(`/api/rounds/${round.id}/brief/images`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      setBrief(prev => ({ ...prev, imagePaths: [...(prev?.imagePaths || []), data.path] }));
    } catch (_ex) {
      setErr(_ex instanceof Error ? _ex.message : "Upload failed");
    }
  };

  const removeImage = async (index: number) => {
    try {
      await api.delete(`rounds/${round.id}/brief/images/${index + 1}`);
      setBrief(prev => {
        const paths = [...(prev?.imagePaths || [])];
        paths.splice(index, 1);
        return { ...prev, imagePaths: paths };
      });
    } catch (_ex) {
      setErr("Failed to delete image");
    }
  };

  const fi = { ...inputStyle, width: "100%", opacity: disabled ? 0.6 : 1 };
  const labelStyle = { fontSize: "0.8rem", color: "#555", display: "block" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
        <div><label style={labelStyle}>Briefing Time</label><input type="time" disabled={disabled} style={fi} value={brief?.briefingTime || ""} onChange={e => handleChange("briefingTime", e.target.value)} /></div>
        <div><label style={labelStyle}>Check-in By</label><input type="time" disabled={disabled} style={fi} value={brief?.checkInByTime || ""} onChange={e => handleChange("checkInByTime", e.target.value)} /></div>
        <div><label style={labelStyle}>Land By</label><input type="time" disabled={disabled} style={fi} value={brief?.landByTime || ""} onChange={e => handleChange("landByTime", e.target.value)} /></div>
        <div><label style={labelStyle}>Takeoff W3W</label><input disabled={disabled} style={fi} value={brief?.takeOffW3W || ""} onChange={e => handleChange("takeOffW3W", e.target.value)} /></div>
        <div><label style={labelStyle}>Briefing W3W</label><input disabled={disabled} style={fi} value={brief?.briefingW3W || ""} onChange={e => handleChange("briefingW3W", e.target.value)} /></div>
        <div><label style={labelStyle}>Parking W3W</label><input disabled={disabled} style={fi} value={brief?.parkingW3W || ""} onChange={e => handleChange("parkingW3W", e.target.value)} /></div>
      </div>
      
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
        <div><label style={labelStyle}>Wind Speed/Dir</label><input disabled={disabled} style={fi} value={brief?.windSpeedDirection || ""} onChange={e => handleChange("windSpeedDirection", e.target.value)} /></div>
        <div><label style={labelStyle}>Direction of Flight</label><input disabled={disabled} style={fi} value={brief?.directionOfFlight || ""} onChange={e => handleChange("directionOfFlight", e.target.value)} /></div>
        <div><label style={labelStyle}>Frequency (MHz)</label><input type="number" step="0.025" disabled={disabled} style={fi} value={brief?.frequencyMhz || ""} onChange={e => handleChange("frequencyMhz", e.target.value ? Number(e.target.value) : undefined)} /></div>
      </div>

      <div><label style={labelStyle}>NOTAMs</label><textarea disabled={disabled} style={{...fi, resize: "vertical"}} value={brief?.NOTAMs || ""} onChange={e => handleChange("NOTAMs", e.target.value)} /></div>
      <div><label style={labelStyle}>BENO Line Description</label><textarea disabled={disabled} style={{...fi, resize: "vertical"}} value={brief?.BENO_LineDescription || ""} onChange={e => handleChange("BENO_LineDescription", e.target.value)} /></div>
      
      <MarkdownBriefField label="Expected Landing Area" value={brief?.expectedLandingArea || ""} disabled={disabled} onChange={v => handleChange("expectedLandingArea", v)} />
      <MarkdownBriefField label="Airspace & Hazards" value={brief?.airspaceAndHazards || ""} disabled={disabled} onChange={v => handleChange("airspaceAndHazards", v)} />
      <MarkdownBriefField label="Briefer's Notes" value={brief?.briefersNotes || ""} disabled={disabled} onChange={v => handleChange("briefersNotes", v)} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
        <div><label style={labelStyle}>Briefer Name</label><input disabled={disabled} style={fi} value={brief?.briefer?.name || ""} onChange={e => handleBrieferChange("name", e.target.value)} /></div>
        <div><label style={labelStyle}>BHPA Level</label><select disabled={disabled} style={fi} value={brief?.briefer?.bhpaCoachLevel ?? ""} onChange={e => handleBrieferChange("bhpaCoachLevel", e.target.value || undefined)}><option value="">—</option>{COACH_TYPES.filter(c => c !== "None").map(c => <option key={c} value={c}>{coachLabel[c]}</option>)}</select></div>
        <div><label style={labelStyle}>BHPA Number</label><input disabled={disabled} style={fi} value={brief?.briefer?.bhpaNumber || ""} onChange={e => handleBrieferChange("bhpaNumber", e.target.value)} /></div>
        <div><label style={labelStyle}>Phone</label><input disabled={disabled} style={fi} value={brief?.briefer?.phoneNumber || ""} onChange={e => handleBrieferChange("phoneNumber", e.target.value)} /></div>
        <div><label style={labelStyle}>Email</label><input disabled={disabled} style={fi} value={brief?.briefer?.emailAddress || ""} onChange={e => handleBrieferChange("emailAddress", e.target.value)} /></div>
      </div>

      <div>
        <label style={labelStyle}>Images</label>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
          {brief?.imagePaths?.map((p, i) => (
            <div key={i} style={{ position: "relative", border: "1px solid #ccc", padding: "0.25rem" }}>
              <AuthImage src={`/api/rounds/${round.id}/brief/images/${i + 1}`} style={{ height: "100px" }} alt="Brief" />
              {!disabled && (
                <button onClick={() => removeImage(i)} style={{ position: "absolute", top: 0, right: 0, background: "red", color: "white" }}>X</button>
              )}
            </div>
          ))}
        </div>
        {!disabled && <input type="file" onChange={uploadImage} />}
      </div>

      {!disabled && (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button onClick={submit} disabled={saving} style={btnStyle("#fff", saving ? "#6c757d" : "#0066cc")}>{saving ? "Saving..." : "Save Brief"}</button>
          {ok && <Banner msg="Saved." ok />}
          {err && <Banner msg={err} />}
        </div>
      )}
    </div>
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
  const { data: clubTeams } = useBlob<ClubTeamSummary[]>("club-teams.json");

  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ label: string; endpoint: string; count: number } | null>(null);

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
  const myClubId = identity.clubId ?? null;
  const isAdmin = identity.roles.includes("Admin");
  const isRoundsCoord = identity.roles.includes("RoundsCoord");
  
  const canManage = isAdmin || (isRoundsCoord && myClubId !== null && myClubId === r.organisingClub?.id);
  const canManageCaptain = canManage && r.status !== "Locked" && r.status !== "Complete";
  const canOverrideSign = r.status === "BriefComplete" && canManage;

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
          {canManage && (r.status === "Locked" || r.status === "Complete") && (
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
      {canManage && workflowActions.length > 0 && (
        <div style={{ ...sectionStyle, display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <strong style={{ fontSize: "0.85rem", color: "#555" }}>Actions:</strong>
          {workflowActions.map((a) => (
            <button
              key={a.endpoint}
              disabled={actionBusy !== null}
              style={btnStyle(a.color, a.bg)}
              onClick={() => {
                if (a.requiresConfirm) {
                  setActionErr(null);
                  setActionBusy(a.label);
                  api.post<{ invalidatedSignatureCount: number }>(`rounds/${r.id}/${a.endpoint}?dryRun=true`)
                    .then(res => setConfirmModal({ label: a.label, endpoint: a.endpoint, count: res.invalidatedSignatureCount || 0 }))
                    .catch(ex => setActionErr(ex instanceof Error ? ex.message : "Dry run failed"))
                    .finally(() => setActionBusy(null));
                } else {
                  void runAction(a.label, () => api.post(`rounds/${r.id}/${a.endpoint}`));
                }
              }}
            >
              {actionBusy === a.label ? "Working…" : a.label}
            </button>
          ))}
          {actionErr && <Banner msg={actionErr} />}
          {confirmModal && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
              <div style={{ background: "#fff", padding: "1.5rem", borderRadius: "0.5rem", maxWidth: "400px", width: "100%" }}>
                <h3 style={{ marginTop: 0 }}>Confirm {confirmModal.label}</h3>
                <p>This will reset <strong>{confirmModal.count}</strong> pilot signature(s) (their 'Sign To Fly' flags will be reset).</p>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1.5rem" }}>
                  <button onClick={() => setConfirmModal(null)} style={btnStyle("#333", "#e9ecef")}>Cancel</button>
                  <button
                    onClick={() => {
                      const { label, endpoint } = confirmModal;
                      setConfirmModal(null);
                      void runAction(label, () => api.post(`rounds/${r.id}/${endpoint}`));
                    }}
                    style={btnStyle("#fff", "#dc3545")}
                  >
                    Confirm & {confirmModal.label.includes("Reopen") ? "Reopen" : "Proceed"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Metadata */}
      {canManage && (
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
      )}

      {/* Brief Form */}
      {canManage && (
        <section style={sectionStyle}>
          <BriefForm round={r} onSaved={() => { void loadRound(); }} />
        </section>
      )}

      {/* Teams */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
          Teams ({r.teams.length} / {r.maxTeams})
        </h2>

        {r.teams
          .slice()
          .sort((a, b) => a.teamName.localeCompare(b.teamName))
          .map((team) => {
            const canEditTeam = canManage || (isRoundsCoord && myClubId !== null && myClubId === team.club.id);
            return (
              <TeamCard
                key={team.id}
                roundId={r.id}
                team={team}
                pilots={pilotsIndex}
                status={r.status}
                canOverrideSign={canOverrideSign}
                canManage={canManage}
                canManageCaptain={canManageCaptain}
                canEditTeam={canEditTeam}
                onChanged={() => { void loadRound(); }}
              />
            );
          })}

        {/* Add team form — only when not locked/complete */}
        {r.status !== "Locked" && r.status !== "Complete" && r.status !== "Cancelled" && (canManage || myClubId != null) && (
          <div style={{ marginTop: "0.5rem" }}>
            <strong style={{ fontSize: "0.85rem" }}>Add Team</strong>
            <AddTeamForm
              roundId={r.id}
              clubs={clubs ?? []}
              clubTeams={clubTeams ?? []}
              seasonYear={r.season.year}
              existingTeams={r.teams}
              onAdded={() => { void loadRound(); }}
              lockedClubId={!canManage ? myClubId : null}
            />
          </div>
        )}
      </section>
    </div>
  );
}
