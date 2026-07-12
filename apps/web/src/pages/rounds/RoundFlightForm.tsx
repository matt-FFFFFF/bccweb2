// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import type { ScoringType } from "@bccweb/types";
import { api } from "../../lib/api.js";
import { btnStyle, inputStyle } from "./RoundManage.shared.js";
import { Banner } from "../../components/Banner.js";

interface FlightFormState {
  distance: string;
  url: string;
  duration: string;
  dateTime: string;
  scoringType: ScoringType;
  isFirstXC: boolean;
  isFirstUKXC: boolean;
}

export function FlightForm({
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
  const fieldId = (name: string) => `flight-${teamId}-${place}-${name}`;

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
          <label htmlFor={fieldId("distance")} style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Distance (km) *</label>
          <input
            id={fieldId("distance")}
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
          <label htmlFor={fieldId("duration")} style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Duration (min)</label>
          <input
            id={fieldId("duration")}
            type="number"
            min={0}
            style={fi}
            value={form.duration}
            onChange={(e) => setF("duration", e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={fieldId("scoring-type")} style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Scoring type</label>
          <select
            id={fieldId("scoring-type")}
            style={fi}
            value={form.scoringType}
            onChange={(e) => setF("scoringType", e.target.value as ScoringType)}
          >
            <option value="XC">XC</option>
            <option value="Manual">Manual</option>
          </select>
        </div>
        <div>
          <label htmlFor={fieldId("date-time")} style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Date/time</label>
          <input
            id={fieldId("date-time")}
            type="datetime-local"
            style={fi}
            value={form.dateTime}
            onChange={(e) => setF("dateTime", e.target.value)}
          />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <label htmlFor={fieldId("url")} style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Flight URL</label>
          <input
            id={fieldId("url")}
            type="url"
            style={fi}
            placeholder="https://…"
            value={form.url}
            onChange={(e) => setF("url", e.target.value)}
          />
        </div>
      </div>
      <div style={{ display: "flex", gap: "1rem", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
        <label htmlFor={fieldId("first-xc")} style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
          <input
            id={fieldId("first-xc")}
            type="checkbox"
            checked={form.isFirstXC}
            onChange={(e) => setF("isFirstXC", e.target.checked)}
          />
          First XC
        </label>
        <label htmlFor={fieldId("first-uk-xc")} style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
          <input
            id={fieldId("first-uk-xc")}
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
