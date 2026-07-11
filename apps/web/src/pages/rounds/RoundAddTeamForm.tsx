// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import type { ClubSummary, ClubTeamSummary, Team } from "@bccweb/types";
import { api } from "../../lib/api.js";
import { btnStyle, inputStyle } from "./RoundManage.shared.js";
import { Banner } from "../../components/Banner.js";

export function AddTeamForm({
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
