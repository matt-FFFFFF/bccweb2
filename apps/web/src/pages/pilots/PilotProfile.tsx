import { useState, useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import type { Pilot, CoachType, PilotRatingValue, WingClass } from "@bccweb/types";
import { useAuth } from "../../hooks/useAuth.js";
import { api, ApiError } from "../../lib/api.js";
import { LoadingSpinner, ErrorMessage } from "../../components/LoadingSpinner.js";

// ─── Shared styles ────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #ccc",
  borderRadius: "0.3rem",
  fontSize: "0.875rem",
  boxSizing: "border-box",
  width: "100%",
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

// ─── Display row ──────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value?: string | number | null }) {
  if (!value && value !== 0) return null;
  return (
    <tr style={{ borderBottom: "1px solid #f0f0f0" }}>
      <td
        style={{
          padding: "0.4rem 0.6rem",
          color: "#888",
          fontWeight: 600,
          fontSize: "0.8rem",
          whiteSpace: "nowrap",
          verticalAlign: "top",
          width: 180,
        }}
      >
        {label}
      </td>
      <td style={{ padding: "0.4rem 0.6rem", color: "#333" }}>{value}</td>
    </tr>
  );
}

// ─── Edit form ────────────────────────────────────────────────────────────────

const COACH_TYPES: CoachType[] = ["None", "ClubCoach", "SeniorCoach", "Instructor", "SeniorInstructor"];
const PILOT_RATINGS: PilotRatingValue[] = ["Club Pilot", "Pilot", "Advanced Pilot"];
const WING_CLASSES: WingClass[] = ["EN A", "EN B", "EN C", "EN C 2-liner", "EN D", "EN D 2-liner"];

interface EditForm {
  coachType: CoachType;
  pilotRating: PilotRatingValue;
  helmetColour: string;
  harnessType: string;
  harnessColour: string;
  wingClass: WingClass | "";
  wingModel: string;
  wingColours: string;
  pureTrackId: string;
  emergencyContactName: string;
  emergencyPhoneNumber: string;
  medicalInfo: string;
}

function pilotToForm(p: Pilot): EditForm {
  return {
    coachType: p.coachType,
    pilotRating: p.pilotRating,
    helmetColour: p.helmetColour ?? "",
    harnessType: p.harnessType ?? "",
    harnessColour: p.harnessColour ?? "",
    wingClass: p.wingClass ?? "",
    wingModel: p.wingModel ?? "",
    wingColours: p.wingColours ?? "",
    pureTrackId: p.pureTrackId != null ? String(p.pureTrackId) : "",
    emergencyContactName: p.emergencyContactName ?? "",
    emergencyPhoneNumber: p.emergencyPhoneNumber ?? "",
    medicalInfo: p.medicalInfo ?? "",
  };
}

function EditProfileForm({ pilot, onSaved }: { pilot: Pilot; onSaved: () => void }) {
  const [form, setForm] = useState<EditForm>(() => pilotToForm(pilot));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);

  function setF<K extends keyof EditForm>(k: K, v: EditForm[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.put(`pilots/${pilot.id}`, {
        coachType: form.coachType,
        pilotRating: form.pilotRating,
        helmetColour: form.helmetColour || undefined,
        harnessType: form.harnessType || undefined,
        harnessColour: form.harnessColour || undefined,
        wingClass: form.wingClass || undefined,
        wingModel: form.wingModel || undefined,
        wingColours: form.wingColours || undefined,
        pureTrackId: form.pureTrackId ? Number(form.pureTrackId) : undefined,
        emergencyContactName: form.emergencyContactName || undefined,
        emergencyPhoneNumber: form.emergencyPhoneNumber || undefined,
        medicalInfo: form.medicalInfo || undefined,
      });
      setMsg("Saved.");
      setMsgOk(true);
      onSaved();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed to save");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => { void handleSubmit(e); }}
      style={{
        border: "1px solid #dee2e6",
        borderRadius: "0.5rem",
        padding: "1rem",
        marginTop: "1.5rem",
      }}
    >
      <h2 style={{ fontSize: "1rem", margin: "0 0 1rem" }}>Edit Profile</h2>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "0.75rem" }}>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Rating</label>
          <select style={inputStyle} value={form.pilotRating} onChange={(e) => setF("pilotRating", e.target.value as PilotRatingValue)}>
            {PILOT_RATINGS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Coach / Instructor</label>
          <select style={inputStyle} value={form.coachType} onChange={(e) => setF("coachType", e.target.value as CoachType)}>
            {COACH_TYPES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Wing class</label>
          <select style={inputStyle} value={form.wingClass} onChange={(e) => setF("wingClass", e.target.value as WingClass | "")}>
            <option value="">(none)</option>
            {WING_CLASSES.map((wc) => <option key={wc} value={wc}>{wc}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Wing model</label>
          <input style={inputStyle} value={form.wingModel} onChange={(e) => setF("wingModel", e.target.value)} placeholder="e.g. Enzo 3" />
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Wing colours</label>
          <input style={inputStyle} value={form.wingColours} onChange={(e) => setF("wingColours", e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Helmet colour</label>
          <input style={inputStyle} value={form.helmetColour} onChange={(e) => setF("helmetColour", e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Harness type</label>
          <input style={inputStyle} value={form.harnessType} onChange={(e) => setF("harnessType", e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Harness colour</label>
          <input style={inputStyle} value={form.harnessColour} onChange={(e) => setF("harnessColour", e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>PureTrack ID</label>
          <input type="number" min={0} style={inputStyle} value={form.pureTrackId} onChange={(e) => setF("pureTrackId", e.target.value)} />
        </div>
      </div>

      <div style={{ marginTop: "0.75rem" }}>
        <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Emergency contact name</label>
        <input style={inputStyle} value={form.emergencyContactName} onChange={(e) => setF("emergencyContactName", e.target.value)} />
      </div>
      <div style={{ marginTop: "0.5rem" }}>
        <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Emergency contact phone</label>
        <input type="tel" style={inputStyle} value={form.emergencyPhoneNumber} onChange={(e) => setF("emergencyPhoneNumber", e.target.value)} />
      </div>
      <div style={{ marginTop: "0.5rem" }}>
        <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Medical info</label>
        <textarea
          rows={3}
          style={{ ...inputStyle, resize: "vertical" }}
          value={form.medicalInfo}
          onChange={(e) => setF("medicalInfo", e.target.value)}
          placeholder="Relevant medical information for safety purposes"
        />
      </div>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.75rem" }}>
        <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {msg && <Banner msg={msg} ok={msgOk} />}
      </div>
    </form>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const coachLabel: Record<string, string> = {
  None: "Not a coach",
  ClubCoach: "Club Coach",
  SeniorCoach: "Senior Coach",
  Instructor: "Instructor",
  SeniorInstructor: "Senior Instructor",
};

export default function PilotProfile() {
  const { id } = useParams<{ id: string }>();
  const { identity } = useAuth();
  const [refresh, setRefresh] = useState(0);

  const [pilot, setPilot] = useState<Pilot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    api
      .get<Pilot>(`pilots/${id}`)
      .then((data) => {
        if (!cancelled) {
          setPilot(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 404) {
            setNotFound(true);
          } else {
            setError(
              err instanceof ApiError ? err.message : "Could not load pilot"
            );
          }
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, refresh]);

  if (loading) return <LoadingSpinner message="Loading pilot profile…" />;
  if (notFound) return <p>Pilot not found.</p>;
  if (error) return <ErrorMessage error={new Error(error)} title="Could not load pilot" />;
  if (!pilot) return null;

  const canEdit =
    identity !== null &&
    (identity.roles.includes("Admin") || identity.pilotId === pilot.id);

  return (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      {/* Breadcrumb */}
      <nav style={{ marginBottom: "1rem", fontSize: "0.85rem", color: "#888" }}>
        <Link to="/pilots" style={{ color: "#0066cc", textDecoration: "none" }}>
          Pilots
        </Link>{" "}
        / {pilot.person.fullName}
      </nav>

      {/* Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.75rem", margin: "0 0 0.25rem" }}>
          {pilot.person.fullName}
        </h1>
        <p style={{ margin: 0, color: "#555" }}>
          {pilot.pilotRating}
          {pilot.currentClub && ` · ${pilot.currentClub.name}`}
        </p>
      </div>

      {/* Details table */}
      <table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}
      >
        <tbody>
          <Row label="BHPA Number" value={pilot.bhpaNumber} />
          <Row
            label="Coach / Instructor"
            value={
              pilot.coachType !== "None"
                ? coachLabel[pilot.coachType] ?? pilot.coachType
                : undefined
            }
          />
          <Row label="Wing Class" value={pilot.wingClass} />
          <Row
            label="Wing"
            value={
              pilot.wingManufacturer
                ? `${pilot.wingManufacturer.name}${pilot.wingModel ? ` ${pilot.wingModel}` : ""}`
                : pilot.wingModel
            }
          />
          <Row label="Wing Colours" value={pilot.wingColours} />
          <Row label="Helmet Colour" value={pilot.helmetColour} />
          <Row label="Harness Type" value={pilot.harnessType} />
          <Row label="Harness Colour" value={pilot.harnessColour} />
        </tbody>
      </table>

      {/* PureTrack link */}
      {pilot.pureTrackLink && (
        <div style={{ marginTop: "1.25rem" }}>
          <a
            href={pilot.pureTrackLink}
            target="_blank"
            rel="noreferrer"
            style={{ color: "#0066cc" }}
          >
            PureTrack profile →
          </a>
        </div>
      )}

      {/* Season clubs */}
      {pilot.seasonClubs.length > 0 && (
        <section style={{ marginTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Season Clubs</h2>
          <table
            style={{ borderCollapse: "collapse", fontSize: "0.85rem" }}
          >
            <tbody>
              {pilot.seasonClubs
                .slice()
                .sort((a, b) => b.seasonYear - a.seasonYear)
                .map((sc) => (
                  <tr key={sc.seasonYear} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <td style={{ padding: "0.3rem 0.6rem", color: "#888" }}>{sc.seasonYear}</td>
                    <td style={{ padding: "0.3rem 0.6rem" }}>{sc.clubName}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Edit form — shown to the pilot themselves or an admin */}
      {canEdit && (
        <EditProfileForm pilot={pilot} onSaved={() => setRefresh((v) => v + 1)} />
      )}
    </div>
  );
}
