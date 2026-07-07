// SPDX-License-Identifier: MPL-2.0

import { useState } from "react";
import type { Round, PilotSlot, PilotSummary, Team } from "@bccweb/types";
import { useAuth } from "../../../hooks/useAuth.js";
import { useBlob } from "../../../hooks/useBlob.js";
import { api } from "../../../lib/api.js";

interface CoordIgcTableProps {
  round: Round;
  onChanged: () => void;
}

type IgcStatus = "No IGC" | "Uploaded" | "Manual";

/**
 * "Manual" (isManualLog) takes precedence, then an uploaded IGC (igcPath set),
 * otherwise there is no flight / no IGC for the slot.
 */
function igcStatusOf(slot: PilotSlot): IgcStatus {
  const flight = slot.flight;
  if (!flight) return "No IGC";
  if (flight.isManualLog) return "Manual";
  if (flight.igcPath) return "Uploaded";
  return "No IGC";
}

/**
 * Coordinator/admin per-pilot IGC status board for a round. One row per filled
 * pilot slot: shows the IGC status, raw solver distance, sanity flags, and the
 * download / delete actions. Rendered ONLY for an Admin or the RoundsCoord that
 * owns the organising club — plain pilots never see it.
 */
export function CoordIgcTable({ round, onChanged }: CoordIgcTableProps) {
  const { identity } = useAuth();
  const { data: pilotsIndex } = useBlob<PilotSummary[]>("pilots.json");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isAdmin = identity?.roles.includes("Admin") ?? false;
  const isScopedCoord =
    (identity?.roles.includes("RoundsCoord") ?? false) &&
    identity?.clubId != null &&
    identity.clubId === round.organisingClub?.id;

  if (!isAdmin && !isScopedCoord) return null;

  const rows = round.teams.flatMap((team) =>
    team.pilots
      .filter((slot) => slot.status === "Filled" || slot.flight !== null)
      .map((slot) => ({ team, slot })),
  );

  function pilotName(slot: PilotSlot): string {
    if (!slot.pilotId) return "Empty";
    return pilotsIndex?.find((p) => p.id === slot.pilotId)?.name ?? slot.pilotId;
  }

  async function handleDownload(team: Team, slot: PilotSlot) {
    const key = `dl:${team.id}:${slot.placeInTeam}`;
    setBusyKey(key);
    setErrorMsg(null);
    // A plain <a href> cannot carry the JWT — fetch with the Bearer token then
    // hand the browser an object-URL to trigger the download.
    const accessToken = localStorage.getItem("bcc_access_token");
    try {
      const res = await fetch(
        `/api/rounds/${round.id}/teams/${team.id}/pilots/${slot.placeInTeam}/igc`,
        { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} },
      );
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bcc-${round.id}-team-${team.id}-pilot-${slot.placeInTeam}.igc`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Download failed");
    } finally {
      setBusyKey((cur) => (cur === key ? null : cur));
    }
  }

  async function handleDeleteIgc(team: Team, slot: PilotSlot) {
    if (!window.confirm(`Delete the uploaded IGC for ${pilotName(slot)}?`)) return;
    const key = `del:${team.id}:${slot.placeInTeam}`;
    setBusyKey(key);
    setErrorMsg(null);
    try {
      await api.delete(
        `rounds/${round.id}/teams/${team.id}/pilots/${slot.placeInTeam}/igc`,
      );
      onChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusyKey((cur) => (cur === key ? null : cur));
    }
  }

  async function handleDeleteFlight(team: Team, slot: PilotSlot) {
    const flight = slot.flight;
    if (!flight) return;
    if (!window.confirm(`Delete the manual flight for ${pilotName(slot)}?`)) return;
    const key = `delf:${team.id}:${slot.placeInTeam}`;
    setBusyKey(key);
    setErrorMsg(null);
    try {
      await api.delete(`rounds/${round.id}/flights/${flight.id}`);
      onChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusyKey((cur) => (cur === key ? null : cur));
    }
  }

  return (
    <section data-testid="coord-igc-table" style={{ marginTop: "2rem" }}>
      <h2 style={{ fontSize: "1.1rem" }}>Pilot IGC Status</h2>

      {errorMsg && (
        <div
          role="alert"
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
          {errorMsg}
        </div>
      )}

      {rows.length === 0 ? (
        <p style={{ color: "#888", fontSize: "0.9rem" }}>No pilot slots yet.</p>
      ) : (
        <table className="bcc-table bcc-table--striped">
          <thead>
            <tr>
              <th>Team</th>
              <th>Place</th>
              <th>Pilot Name</th>
              <th>IGC Status</th>
              <th style={{ textAlign: "right" }}>Distance (km)</th>
              <th>Sanity Flags</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ team, slot }) => {
              const flight = slot.flight;
              const rowKey = `${team.id}:${slot.placeInTeam}`;
              const dlBusy = busyKey === `dl:${rowKey}`;
              const delBusy =
                busyKey === `del:${rowKey}` || busyKey === `delf:${rowKey}`;
              return (
                <tr key={rowKey}>
                  <td>{team.teamName}</td>
                  <td>{slot.placeInTeam}</td>
                  <td>{pilotName(slot)}</td>
                  <td data-testid="igc-status">{igcStatusOf(slot)}</td>
                  <td style={{ textAlign: "right" }}>
                    {flight ? flight.distance : "—"}
                  </td>
                  <td>
                    {flight?.sanityFlags && flight.sanityFlags.length > 0 ? (
                      <span
                        style={{
                          display: "inline-flex",
                          flexWrap: "wrap",
                          gap: "0.25rem",
                        }}
                      >
                        {flight.sanityFlags.map((f) => (
                          <span
                            key={f}
                            className="bcc-warn"
                            style={{
                              display: "inline-block",
                              padding: "0.1rem 0.4rem",
                              borderRadius: "0.75rem",
                              background: "#fff3cd",
                              color: "#664d03",
                              border: "1px solid #ffe69c",
                              fontSize: "0.7rem",
                              fontWeight: 600,
                            }}
                          >
                            {f}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span style={{ color: "#bbb" }}>—</span>
                    )}
                  </td>
                  <td>
                    <span
                      style={{ display: "inline-flex", gap: "0.4rem", flexWrap: "wrap" }}
                    >
                      {flight?.igcPath && (
                        <>
                          <button
                            type="button"
                            className="bcc-btn bcc-btn--outline"
                            data-testid="download-igc-btn"
                            disabled={dlBusy}
                            onClick={() => {
                              void handleDownload(team, slot);
                            }}
                            style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
                          >
                            {dlBusy ? "Downloading…" : "Download IGC"}
                          </button>
                          <button
                            type="button"
                            className="bcc-btn bcc-btn--ghost"
                            disabled={delBusy}
                            onClick={() => {
                              void handleDeleteIgc(team, slot);
                            }}
                            style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
                          >
                            Delete IGC
                          </button>
                        </>
                      )}
                      {flight?.isManualLog && (
                        <button
                          type="button"
                          className="bcc-btn bcc-btn--ghost"
                          disabled={delBusy}
                          onClick={() => {
                            void handleDeleteFlight(team, slot);
                          }}
                          style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
                        >
                          Delete flight
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
