// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import type { Team, PilotSummary, RoundStatus, PilotSlot } from "@bccweb/types";
import { isRosterFrozen } from "@bccweb/types";
import { api } from "../../lib/api.js";
import { pilotDisplayName, btnStyle, inputStyle } from "./RoundManage.shared.js";
import { Banner } from "../../components/Banner.js";

export function ChangeCaptainSelect({
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
        aria-label={`Captain for ${team.teamName}`}
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
      {err && <Banner msg={err} />}
    </div>
  );
}

export function TeamCard({
  roundId,
  team,
  pilots,
  status,
  canManageCaptain,
  canEditTeam,
  onChanged,
  renderPilotRow,
  renderAddPilotForm,
}: {
  roundId: string;
  team: Team;
  pilots: PilotSummary[] | null;
  status: RoundStatus;
  canManageCaptain: boolean;
  canEditTeam: boolean;
  onChanged: () => void;
  renderPilotRow: (slot: PilotSlot) => React.ReactNode;
  renderAddPilotForm: (showAddPilot: boolean, setShowAddPilot: (b: boolean) => void) => React.ReactNode;
}) {
  const [showAddPilot, setShowAddPilot] = useState(false);
  const [removeErr, setRemoveErr] = useState<string | null>(null);

  const canEdit = !isRosterFrozen(status) && canEditTeam;

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
              {team.score}
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
        {filledSlots.map((slot) => renderPilotRow(slot))}

        {/* Add pilot */}
        {canEdit && (
          <div style={{ marginTop: "0.5rem", paddingBottom: "0.5rem" }}>
            {renderAddPilotForm(showAddPilot, setShowAddPilot)}
          </div>
        )}
      </div>
    </div>
  );
}
