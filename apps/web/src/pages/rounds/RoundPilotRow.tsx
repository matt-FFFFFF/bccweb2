// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import type { PilotSummary, Team, PilotSlot, RoundStatus } from "@bccweb/types";
import { isRosterFrozen } from "@bccweb/types";
import { api } from "../../lib/api.js";
import { btnStyle } from "./RoundManage.shared.js";
import { PilotName } from "./RoundPilotName.js";
import { Banner } from "../../components/Banner.js";
import { FlightForm } from "./RoundFlightForm.js";
import { OverrideSignModal } from "./RoundOverrideSignModal.js";

export function PilotRow({
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

  const isLocked = status === "Locked";
  const canFlight = isLocked;

  async function toggleAccounted(current: boolean) {
    setActionErr(null);
    try {
      await api.put(
        `rounds/${roundId}/teams/${team.id}/pilots/${slot.placeInTeam}/accounted`,
        { accountedFor: !current }
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
              <span
                title="Handicap score (distance × pilot factor × wing factor), before round normalisation"
                style={{ marginLeft: "0.3rem", fontWeight: 700, color: "#0a3622" }}
              >
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
            onClick={() => { setOverrideOpen(true);  }}
          >
            Override Sign
          </button>
        )}

        {/* Remove pilot */}
        {canEditTeam && !isRosterFrozen(status) && slot.status === "Filled" && (
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
        <OverrideSignModal
          roundId={roundId}
          team={team}
          slot={slot}
          pilots={pilots}
          onClose={() => setOverrideOpen(false)}
          onSuccess={() => {
            setOverrideOpen(false);
            setActionOk("Override signature recorded.");
            onChanged();
          }}
        />
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
