import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import type { Pilot, PilotClubMembership, CoachType, PilotRatingValue, WingClass, ManufacturerRef, ClubSummary, Manufacturer, SeasonResults } from "@bccweb/types";
import { PILOT_RATINGS, WING_CLASSES } from "@bccweb/types";
import { useAuth } from "../../hooks/useAuth.js";
import { useBlob } from "../../hooks/useBlob.js";
import { api, ApiError } from "../../lib/api.js";
import { LoadingSpinner, ErrorMessage } from "../../components/LoadingSpinner.js";
import { COACH_TYPES, coachLabel } from "../../lib/coach.js";
import { safeExternalUrl } from "../../lib/url.js";

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

function ManufacturerLink({ manufacturer, model }: { manufacturer: ManufacturerRef; model?: string }) {
  const url = safeExternalUrl(manufacturer.websiteUrl);
  const label = `${manufacturer.name}${model ? ` ${model}` : ""}`;
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#0066cc" }}>
      {label}
    </a>
  ) : (
    <>{label}</>
  );
}

// ─── Display row ──────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value?: ReactNode }) {
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

interface EditForm {
  coachType: CoachType;
  pilotRating: PilotRatingValue;
  bhpaNumber: string;
  helmetColour: string;
  harnessType: string;
  harnessColour: string;
  wingClass: WingClass | "";
  wingModel: string;
  wingColours: string;
  pureTrackId: string;
  pureTrackLink: string;
  emergencyContactName: string;
  emergencyPhoneNumber: string;
  medicalInfo: string;
  currentClubId: string;
  wingManufacturerId: string;
}

function pilotToForm(p: Pilot): EditForm {
  return {
    coachType: p.coachType,
    pilotRating: p.pilotRating,
    bhpaNumber: p.bhpaNumber != null ? String(p.bhpaNumber) : "",
    helmetColour: p.helmetColour ?? "",
    harnessType: p.harnessType ?? "",
    harnessColour: p.harnessColour ?? "",
    wingClass: p.wingClass ?? "",
    wingManufacturerId: p.wingManufacturer?.id ?? "",
    wingModel: p.wingModel ?? "",
    wingColours: p.wingColours ?? "",
    pureTrackId: p.pureTrackId != null ? String(p.pureTrackId) : "",
    pureTrackLink: p.pureTrackLink ?? "",
    emergencyContactName: p.emergencyContactName ?? "",
    emergencyPhoneNumber: p.emergencyPhoneNumber ?? "",
    medicalInfo: p.medicalInfo ?? "",
    currentClubId: p.currentClub?.id ?? "",
  };
}

function EditProfileForm({
  pilot,
  isAdmin,
  activeSeasonYear,
  onSaved,
}: {
  pilot: Pilot;
  isAdmin: boolean;
  activeSeasonYear: number | undefined;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<EditForm>(() => pilotToForm(pilot));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);
  const { data: clubs } = useBlob<ClubSummary[]>("clubs.json");
  const { data: manufacturers } = useBlob<Manufacturer[]>("manufacturers.json");
  const { data: seasonResults } = useBlob<SeasonResults>(
    activeSeasonYear ? `results/${activeSeasonYear}.json` : null,
  );

  const seasonClubEntry = activeSeasonYear
    ? pilot.seasonClubs.find((sc) => sc.seasonYear === activeSeasonYear)
    : undefined;
  // While results load, `seasonResults` is undefined ⇒ flown false ⇒ dropdown
  // briefly enabled; the API 409 (CLUB_LOCKED) is the backstop.
  const flown = !!seasonResults?.some((rr) =>
    rr.teamResults.some((tr) => tr.pilots.some((p) => p.pilotId === pilot.id)),
  );
  const clubLocked = !isAdmin && flown;

  function setF<K extends keyof EditForm>(k: K, v: EditForm[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const selectedClub = clubs?.find((c) => c.id === form.currentClubId);
      const clubChanged = (selectedClub?.id ?? "") !== (pilot.currentClub?.id ?? "");
      const currentClubPayload =
        clubChanged && !clubLocked
          ? selectedClub
            ? { id: selectedClub.id, name: selectedClub.name }
            : undefined
          : undefined;

      const m = manufacturers?.find((x) => x.id === form.wingManufacturerId);
      const wingManufacturerPayload = m
        ? m.websiteUrl
          ? { id: m.id, name: m.name, websiteUrl: m.websiteUrl }
          : { id: m.id, name: m.name }
        : undefined;

      await api.put(`pilots/${pilot.id}`, {
        coachType: form.coachType,
        pilotRating: form.pilotRating,
        bhpaNumber: form.bhpaNumber ? Number(form.bhpaNumber) : undefined,
        helmetColour: form.helmetColour || undefined,
        harnessType: form.harnessType || undefined,
        harnessColour: form.harnessColour || undefined,
        wingClass: form.wingClass || undefined,
        wingManufacturer: form.wingManufacturerId === "" ? undefined : wingManufacturerPayload,
        wingModel: form.wingModel || undefined,
        wingColours: form.wingColours || undefined,
        pureTrackId: form.pureTrackId ? Number(form.pureTrackId) : undefined,
        pureTrackLink: form.pureTrackLink || undefined,
        emergencyContactName: form.emergencyContactName || undefined,
        emergencyPhoneNumber: form.emergencyPhoneNumber || undefined,
        medicalInfo: form.medicalInfo || undefined,
        currentClub: currentClubPayload,
      });
      setMsg("Saved.");
      setMsgOk(true);
      onSaved();
    } catch (ex) {
      if (ex instanceof ApiError && ex.code === "CLUB_LOCKED") {
        setMsg("Your club is locked for this season because you've flown a scored round. Contact an admin to change it.");
        setMsgOk(false);
        onSaved();
      } else {
        setMsg(ex instanceof ApiError ? ex.message : ex instanceof Error ? ex.message : "Failed to save");
        setMsgOk(false);
      }
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
            {COACH_TYPES.map((c) => <option key={c} value={c}>{coachLabel[c]}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>BHPA number</label>
          <input type="number" min={0} style={inputStyle} value={form.bhpaNumber} onChange={(e) => setF("bhpaNumber", e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Wing class</label>
          <select style={inputStyle} value={form.wingClass} onChange={(e) => setF("wingClass", e.target.value as WingClass | "")}>
            <option value="">(none)</option>
            {WING_CLASSES.map((wc) => <option key={wc} value={wc}>{wc}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="wingManufacturerId" style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Wing manufacturer</label>
          <select id="wingManufacturerId" style={inputStyle} value={form.wingManufacturerId} onChange={(e) => setF("wingManufacturerId", e.target.value)}>
            <option value="">(none)</option>
            {pilot.wingManufacturer && (!manufacturers || !manufacturers.some(x => x.id === pilot.wingManufacturer!.id)) && (
              <option value={pilot.wingManufacturer.id}>{pilot.wingManufacturer.name}</option>
            )}
            {manufacturers?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
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
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>PureTrack link</label>
          <input type="url" style={inputStyle} value={form.pureTrackLink} onChange={(e) => setF("pureTrackLink", e.target.value)} placeholder="https://puretrack.io/..." />
        </div>
      </div>

      <div style={{ marginTop: "0.75rem" }}>
        <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>
          Current club{clubLocked && " (locked for this season)"}
        </label>
        <select
          style={{ ...inputStyle, background: clubLocked ? "#f1f3f5" : undefined }}
          value={form.currentClubId}
          onChange={(e) => setF("currentClubId", e.target.value)}
          disabled={clubLocked}
        >
          <option value="">— None —</option>
          {clubs?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {seasonClubEntry && (
          <p style={{ margin: "0.3rem 0 0", fontSize: "0.75rem", color: "#666" }}>
            Your {activeSeasonYear} club: <strong>{seasonClubEntry.clubName}</strong>
          </p>
        )}
        {clubLocked && (
          <p style={{ margin: "0.3rem 0 0", fontSize: "0.75rem", color: "#666" }}>
            Locked for the {activeSeasonYear} season because you&apos;ve flown a scored round — contact an admin.
          </p>
        )}
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

export default function PilotProfile() {
  const { id } = useParams<{ id: string }>();
  const { identity } = useAuth();
  const [refresh, setRefresh] = useState(0);

  const [pilot, setPilot] = useState<Pilot | null>(null);
  const [clubHistory, setClubHistory] = useState<PilotClubMembership[] | null>(null);
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

    api
      .get<PilotClubMembership[]>(`pilots/${id}/club-history`)
      .then((data) => {
        if (!cancelled) setClubHistory(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 404) {
            setClubHistory([]);
          } else {
            setClubHistory(null);
          }
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
              pilot.wingManufacturer ? (
                <ManufacturerLink manufacturer={pilot.wingManufacturer} model={pilot.wingModel} />
              ) : (
                pilot.wingModel
              )
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

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Club History</h2>
        {clubHistory && clubHistory.length > 0 ? (
          <table style={{ borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <tbody>
              {clubHistory.map((m) => (
                <tr key={`${m.clubId}-${m.joinedAt}`} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td style={{ padding: "0.3rem 0.6rem", color: "#888" }}>{m.clubName}</td>
                  <td style={{ padding: "0.3rem 0.6rem" }}>{m.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: "#888" }}>No club history recorded.</p>
        )}
      </section>

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
        <EditProfileForm
          pilot={pilot}
          isAdmin={identity?.roles.includes("Admin") ?? false}
          activeSeasonYear={identity?.activeSeasonYear}
          onSaved={() => setRefresh((v) => v + 1)}
        />
      )}
    </div>
  );
}
