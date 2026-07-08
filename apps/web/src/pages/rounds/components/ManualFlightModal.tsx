// SPDX-License-Identifier: MPL-2.0

import { useEffect, useState, type CSSProperties } from "react";
import type { Flight } from "@bccweb/types";
import { api, ApiError } from "../../../lib/api.js";

interface ManualFlightModalProps {
  roundId: string;
  teamId: string;
  place: number;
  pilotName: string;
  isOpen: boolean;
  onClose: () => void;
  onSaved: (f: Flight) => void;
}

/** Server rejects distance > this; mirror it client-side so bad input never leaves the browser. */
const MAX_DISTANCE_KM = 10000;
/** Coordinators must document WHY a manual distance was entered — the server requires non-empty; the UI asks for a real sentence. */
const MIN_JUSTIFICATION = 10;

const labelStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: "#555",
  display: "block",
  marginBottom: "0.2rem",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.4rem 0.5rem",
  border: "1px solid #ccc",
  borderRadius: "0.375rem",
  fontSize: "0.9rem",
  boxSizing: "border-box",
};

const fieldErrorStyle: CSSProperties = {
  color: "#b02a37",
  fontSize: "0.75rem",
  marginTop: "0.2rem",
};

/**
 * Coordinator/admin modal to record a manually measured flight distance for a
 * single round slot (e.g. when a pilot's logger failed and the distance is
 * estimated from PureTrack). Always records a `scoringType:"Manual"` flight —
 * there is no scoring-type picker. Client-side validation mirrors the server
 * (`distance` in (0, 10000]; a justification of at least a short sentence) so
 * obviously-bad input is rejected before the round-trip; the server enforces
 * the same rules and any 4xx is surfaced inline near the relevant field.
 *
 * Visibility is the CALLER's responsibility — this component is only rendered by
 * `CoordIgcTable`, which is itself gated to Admin / owning RoundsCoord, so plain
 * Pilots can never reach it.
 */
export function ManualFlightModal({
  roundId,
  teamId,
  place,
  pilotName,
  isOpen,
  onClose,
  onSaved,
}: ManualFlightModalProps) {
  const [distance, setDistance] = useState("");
  const [justification, setJustification] = useState("");
  const [url, setUrl] = useState("");
  const [duration, setDuration] = useState("");
  const [dateTime, setDateTime] = useState("");
  const [distanceError, setDistanceError] = useState<string | null>(null);
  const [justificationError, setJustificationError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Present a fresh form every time the modal (re)opens for a slot.
  useEffect(() => {
    if (isOpen) {
      setDistance("");
      setJustification("");
      setUrl("");
      setDuration("");
      setDateTime("");
      setDistanceError(null);
      setJustificationError(null);
      setFormError(null);
      setSaving(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  async function handleSave() {
    setDistanceError(null);
    setJustificationError(null);
    setFormError(null);

    // ── Client-side validation (the server enforces the same rules) ──
    const distanceNum = Number(distance);
    let invalid = false;
    if (
      distance.trim() === "" ||
      !Number.isFinite(distanceNum) ||
      distanceNum <= 0 ||
      distanceNum > MAX_DISTANCE_KM
    ) {
      setDistanceError(
        `Distance must be a number greater than 0 and at most ${MAX_DISTANCE_KM} km.`,
      );
      invalid = true;
    }
    const trimmedJustification = justification.trim();
    if (trimmedJustification.length < MIN_JUSTIFICATION) {
      setJustificationError(
        `Justification is required (at least ${MIN_JUSTIFICATION} characters).`,
      );
      invalid = true;
    }
    if (invalid) return;

    const body: {
      distance: number;
      manualLogJustification: string;
      url?: string;
      duration?: number;
      dateTime?: string;
    } = {
      distance: distanceNum,
      manualLogJustification: trimmedJustification,
    };
    const trimmedUrl = url.trim();
    if (trimmedUrl !== "") body.url = trimmedUrl;
    if (duration.trim() !== "") {
      const durationNum = Number(duration);
      if (Number.isFinite(durationNum)) body.duration = durationNum;
    }
    if (dateTime !== "") body.dateTime = dateTime;

    setSaving(true);
    try {
      const flight = await api.post<Flight>(
        `rounds/${roundId}/teams/${teamId}/pilots/${place}/manual-flight`,
        body,
      );
      onSaved(flight);
      onClose();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? (err.detail ?? err.message)
          : err instanceof Error
            ? err.message
            : "Failed to save manual flight";
      // Surface the server's 4xx near the field it concerns.
      if (err instanceof ApiError && err.status === 422) {
        setJustificationError(message);
      } else if (err instanceof ApiError && /distance/i.test(message)) {
        setDistanceError(message);
      } else {
        setFormError(message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "2rem 1rem",
        zIndex: 1000,
        overflowY: "auto",
      }}
    >
      <div
        data-testid="manual-flight-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-flight-title"
        style={{
          background: "#fff",
          borderRadius: "0.5rem",
          padding: "1.25rem",
          width: "min(30rem, 100%)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
        }}
      >
        <h3
          id="manual-flight-title"
          style={{ margin: "0 0 0.25rem", fontSize: "1.05rem" }}
        >
          Manual Flight Entry
        </h3>
        <p style={{ margin: "0 0 0.85rem", color: "#555", fontSize: "0.85rem" }}>
          {pilotName} — record a manually measured flight distance for this slot.
        </p>

        {formError && (
          <div
            role="alert"
            data-testid="manual-form-error"
            style={{
              padding: "0.5rem",
              marginBottom: "0.75rem",
              backgroundColor: "#f8d7da",
              color: "#58151c",
              borderRadius: "0.375rem",
              border: "1px solid #f1aeb5",
              fontSize: "0.85rem",
            }}
          >
            {formError}
          </div>
        )}

        <div style={{ marginBottom: "0.75rem" }}>
          <label htmlFor="manual-distance" style={labelStyle}>
            Distance (km) *
          </label>
          <input
            id="manual-distance"
            data-testid="manual-distance-input"
            type="number"
            min={0}
            step={0.1}
            value={distance}
            onChange={(e) => setDistance(e.target.value)}
            style={inputStyle}
          />
          {distanceError && (
            <div data-testid="distance-error" style={fieldErrorStyle}>
              {distanceError}
            </div>
          )}
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label htmlFor="manual-justification" style={labelStyle}>
            Justification * (min {MIN_JUSTIFICATION} characters)
          </label>
          <textarea
            id="manual-justification"
            data-testid="manual-justification-input"
            rows={3}
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder="e.g. Pilot logger died at 14:30; distance estimated from PureTrack"
            style={{ ...inputStyle, resize: "vertical" }}
          />
          {justificationError && (
            <div data-testid="justification-error" style={fieldErrorStyle}>
              {justificationError}
            </div>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "0.75rem",
            marginBottom: "0.75rem",
          }}
        >
          <div>
            <label htmlFor="manual-duration" style={labelStyle}>
              Duration (min)
            </label>
            <input
              id="manual-duration"
              data-testid="manual-duration-input"
              type="number"
              min={0}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <label htmlFor="manual-datetime" style={labelStyle}>
              Date/time
            </label>
            <input
              id="manual-datetime"
              data-testid="manual-datetime-input"
              type="datetime-local"
              value={dateTime}
              onChange={(e) => setDateTime(e.target.value)}
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label htmlFor="manual-url" style={labelStyle}>
            Flight URL
          </label>
          <input
            id="manual-url"
            data-testid="manual-url-input"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            style={inputStyle}
          />
        </div>

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="bcc-btn bcc-btn--ghost"
            data-testid="manual-cancel-btn"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="bcc-btn bcc-btn--primary"
            data-testid="manual-save-btn"
            disabled={saving}
            onClick={() => {
              void handleSave();
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
