// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState, useEffect } from "react";
import type { Round, RoundBrief, Pilot } from "@bccweb/types";
import { api } from "../../lib/api.js";
import { COACH_TYPES, coachLabel } from "../../lib/coach.js";
import { btnStyle, inputStyle } from "./RoundManage.shared.js";
import { Banner } from "../../components/Banner.js";
import { MarkdownView } from "../../components/MarkdownView.js";
import { MarkdownEditor } from "../../components/MarkdownEditor.js";
import { AuthImage } from "../../components/AuthImage.js";
import { useAuth } from "../../hooks/useAuth.js";

export function MarkdownBriefField({
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
  const labelId = `brief-markdown-${label.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;
  return (
    <div role="group" aria-labelledby={labelId}>
      <span id={labelId} style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>{label}</span>
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

export function BriefForm({ round, onSaved }: { round: Round; onSaved: () => void }) {
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
          const existing = loaded.briefer ?? {};
          loaded = {
            ...loaded,
            briefer: {
              ...existing,
              name: existing.name || me.person?.fullName || undefined,
              bhpaCoachLevel: existing.bhpaCoachLevel ?? (me.coachType !== "None" ? me.coachType : undefined),
              bhpaNumber: existing.bhpaNumber ?? (me.bhpaNumber != null ? String(me.bhpaNumber) : undefined),
              phoneNumber: existing.phoneNumber || me.person?.phoneNumber || undefined,
              emailAddress: existing.emailAddress || identity.email || undefined,
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

  const disabled = round.status === "BriefComplete" || round.status === "Locked" || round.status === "Complete" || round.status === "Cancelled";

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
  const fieldId = (name: string) => `brief-${round.id}-${name}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
        <div><label htmlFor={fieldId("briefing-time")} style={labelStyle}>Briefing Time</label><input id={fieldId("briefing-time")} type="time" disabled={disabled} style={fi} value={brief?.briefingTime || ""} onChange={e => handleChange("briefingTime", e.target.value)} /></div>
        <div><label htmlFor={fieldId("check-in-by")} style={labelStyle}>Check-in By</label><input id={fieldId("check-in-by")} type="time" disabled={disabled} style={fi} value={brief?.checkInByTime || ""} onChange={e => handleChange("checkInByTime", e.target.value)} /></div>
        <div><label htmlFor={fieldId("land-by")} style={labelStyle}>Land By</label><input id={fieldId("land-by")} type="time" disabled={disabled} style={fi} value={brief?.landByTime || ""} onChange={e => handleChange("landByTime", e.target.value)} /></div>
        <div><label htmlFor={fieldId("takeoff-w3w")} style={labelStyle}>Takeoff W3W</label><input id={fieldId("takeoff-w3w")} disabled={disabled} style={fi} value={brief?.takeOffW3W || ""} onChange={e => handleChange("takeOffW3W", e.target.value)} /></div>
        <div><label htmlFor={fieldId("briefing-w3w")} style={labelStyle}>Briefing W3W</label><input id={fieldId("briefing-w3w")} disabled={disabled} style={fi} value={brief?.briefingW3W || ""} onChange={e => handleChange("briefingW3W", e.target.value)} /></div>
        <div><label htmlFor={fieldId("parking-w3w")} style={labelStyle}>Parking W3W</label><input id={fieldId("parking-w3w")} disabled={disabled} style={fi} value={brief?.parkingW3W || ""} onChange={e => handleChange("parkingW3W", e.target.value)} /></div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
        <div><label htmlFor={fieldId("wind")} style={labelStyle}>Wind Speed/Dir</label><input id={fieldId("wind")} disabled={disabled} style={fi} value={brief?.windSpeedDirection || ""} onChange={e => handleChange("windSpeedDirection", e.target.value)} /></div>
        <div><label htmlFor={fieldId("flight-direction")} style={labelStyle}>Direction of Flight</label><input id={fieldId("flight-direction")} disabled={disabled} style={fi} value={brief?.directionOfFlight || ""} onChange={e => handleChange("directionOfFlight", e.target.value)} /></div>
        <div><label htmlFor={fieldId("frequency")} style={labelStyle}>Frequency (MHz)</label><input id={fieldId("frequency")} type="number" step="0.025" disabled={disabled} style={fi} value={brief?.frequencyMhz || ""} onChange={e => handleChange("frequencyMhz", e.target.value ? Number(e.target.value) : undefined)} /></div>
      </div>

      <div><label htmlFor={fieldId("notams")} style={labelStyle}>NOTAMs</label><textarea id={fieldId("notams")} disabled={disabled} style={{...fi, resize: "vertical"}} value={brief?.NOTAMs || ""} onChange={e => handleChange("NOTAMs", e.target.value)} /></div>
      <div><label htmlFor={fieldId("beno-line")} style={labelStyle}>BENO Line Description</label><textarea id={fieldId("beno-line")} disabled={disabled} style={{...fi, resize: "vertical"}} value={brief?.BENO_LineDescription || ""} onChange={e => handleChange("BENO_LineDescription", e.target.value)} /></div>

      <MarkdownBriefField label="Expected Landing Area" value={brief?.expectedLandingArea || ""} disabled={disabled} onChange={v => handleChange("expectedLandingArea", v)} />
      <MarkdownBriefField label="Airspace & Hazards" value={brief?.airspaceAndHazards || ""} disabled={disabled} onChange={v => handleChange("airspaceAndHazards", v)} />
      <MarkdownBriefField label="Briefer's Notes" value={brief?.briefersNotes || ""} disabled={disabled} onChange={v => handleChange("briefersNotes", v)} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
        <div><label htmlFor={fieldId("briefer-name")} style={labelStyle}>Briefer Name</label><input id={fieldId("briefer-name")} disabled={disabled} style={fi} value={brief?.briefer?.name || ""} onChange={e => handleBrieferChange("name", e.target.value)} /></div>
        <div><label htmlFor={fieldId("bhpa-level")} style={labelStyle}>BHPA Level</label><select id={fieldId("bhpa-level")} disabled={disabled} style={fi} value={brief?.briefer?.bhpaCoachLevel && brief.briefer.bhpaCoachLevel !== "None" ? brief.briefer.bhpaCoachLevel : ""} onChange={e => handleBrieferChange("bhpaCoachLevel", e.target.value || undefined)}><option value="">—</option>{COACH_TYPES.filter(c => c !== "None").map(c => <option key={c} value={c}>{coachLabel[c]}</option>)}</select></div>
        <div><label htmlFor={fieldId("bhpa-number")} style={labelStyle}>BHPA Number</label><input id={fieldId("bhpa-number")} disabled={disabled} style={fi} value={brief?.briefer?.bhpaNumber || ""} onChange={e => handleBrieferChange("bhpaNumber", e.target.value)} /></div>
        <div><label htmlFor={fieldId("briefer-phone")} style={labelStyle}>Phone</label><input id={fieldId("briefer-phone")} disabled={disabled} style={fi} value={brief?.briefer?.phoneNumber || ""} onChange={e => handleBrieferChange("phoneNumber", e.target.value)} /></div>
        <div><label htmlFor={fieldId("briefer-email")} style={labelStyle}>Email</label><input id={fieldId("briefer-email")} disabled={disabled} style={fi} value={brief?.briefer?.emailAddress || ""} onChange={e => handleBrieferChange("emailAddress", e.target.value)} /></div>
      </div>

      <div>
        <label htmlFor={fieldId("images")} style={labelStyle}>Images</label>
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
        {!disabled && <input id={fieldId("images")} type="file" onChange={uploadImage} />}
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
