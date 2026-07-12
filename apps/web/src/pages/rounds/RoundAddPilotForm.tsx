// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import type { PilotSummary } from "@bccweb/types";
import { api } from "../../lib/api.js";
import { btnStyle, inputStyle } from "./RoundManage.shared.js";
import { Banner } from "../../components/Banner.js";

export function AddPilotForm({
  roundId,
  teamId,
  teamName,
  teamClubId,
  teamClubName,
  pilots,
  onAdded,
}: {
  roundId: string;
  teamId: string;
  teamName: string;
  teamClubId: string;
  teamClubName: string;
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

  const filteredPilots = pilots.filter(
    (p) => p.clubId === teamClubId || p.clubId == null
  );

  const sortedPilots = [...filteredPilots].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <form
      onSubmit={(e) => { void submit(e); }}
      style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", marginTop: "0.5rem" }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", flexShrink: 1 }}>
        <select
          aria-label={`Pilot for ${teamName}`}
          required
          style={{ ...inputStyle, minWidth: 180 }}
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
        {sortedPilots.length === 0 && (
          <span style={{ fontSize: "0.75rem", color: "#888" }}>
            No pilots available for {teamClubName}.
          </span>
        )}
        <span style={{ fontSize: "0.75rem", color: "#888" }}>
          Pilots without a confirmed season club are shown; the server verifies club on save.
        </span>
      </div>
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
        disabled={busy || sortedPilots.length === 0}
        style={btnStyle("#fff", busy || sortedPilots.length === 0 ? "#6c757d" : "#0a6640")}
      >
        {busy ? "Adding…" : "Add Pilot"}
      </button>
      {err && <Banner msg={err} />}
    </form>
  );
}
