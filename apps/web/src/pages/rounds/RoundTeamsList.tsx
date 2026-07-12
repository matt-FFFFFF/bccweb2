// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Round, PilotSummary, ClubSummary, ClubTeamSummary } from "@bccweb/types";
import { isRosterFrozen } from "@bccweb/types";
import { sectionStyle, btnStyle } from "./RoundManage.shared.js";
import { TeamCard } from "./TeamCard.js";
import { PilotRow } from "./RoundPilotRow.js";
import { AddPilotForm } from "./RoundAddPilotForm.js";
import { AddTeamForm } from "./RoundAddTeamForm.js";

export function RoundTeamsList({
  r,
  pilotsIndex,
  clubs,
  clubTeams,
  canManage,
  canOverrideSign,
  isRoundsCoord,
  isAdmin,
  myClubId,
  loadRound,
}: {
  r: Round;
  pilotsIndex: PilotSummary[] | null;
  clubs: ClubSummary[] | null;
  clubTeams: ClubTeamSummary[] | null;
  canManage: boolean;
  canOverrideSign: boolean;
  isRoundsCoord: boolean;
  isAdmin: boolean;
  myClubId: string | null;
  loadRound: () => void;
}) {
  return (
    <section style={sectionStyle}>
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
        Teams ({r.teams.length} / {r.maxTeams})
      </h2>

      {r.teams
        .slice()
        .sort((a, b) => a.teamName.localeCompare(b.teamName))
        .map((team) => {
          const canEditTeam = canManage || (isRoundsCoord && myClubId !== null && myClubId === team.club.id);
          return (
            <TeamCard
              key={team.id}
              roundId={r.id}
              team={team}
              pilots={pilotsIndex ?? null}
              status={r.status}
              canManageCaptain={!isRosterFrozen(r.status) && (isAdmin || (isRoundsCoord && myClubId !== null && myClubId === team.club.id))}
              canEditTeam={canEditTeam}
              onChanged={() => { loadRound(); }}
              renderPilotRow={(slot) => (
                <PilotRow
                  key={slot.placeInTeam}
                  roundId={r.id}
                  team={team}
                  slot={slot}
                  pilots={pilotsIndex ?? null}
                  status={r.status}
                  canOverrideSign={canOverrideSign}
                  canManage={canManage}
                  canEditTeam={canEditTeam}
                  onChanged={() => { loadRound(); }}
                />
              )}
              renderAddPilotForm={(showAddPilot, setShowAddPilot) => showAddPilot ? (
                <AddPilotForm
                  roundId={r.id}
                  teamId={team.id}
                  teamName={team.teamName}
                  teamClubId={team.club.id}
                  teamClubName={team.club.name}
                  pilots={pilotsIndex ?? []}
                  onAdded={() => { setShowAddPilot(false); loadRound(); }}
                />
              ) : (
                <button
                  style={btnStyle("#0a6640", "#e8f5e9")}
                  onClick={() => setShowAddPilot(true)}
                >
                  + Add Pilot
                </button>
              )}
            />
          );
        })}

      {!isRosterFrozen(r.status) && (canManage || myClubId != null) && (
        <div style={{ marginTop: "0.5rem" }}>
          <strong style={{ fontSize: "0.85rem" }}>Add Team</strong>
          <AddTeamForm
            roundId={r.id}
            clubs={clubs ?? []}
            clubTeams={clubTeams ?? []}
            seasonYear={r.season.year}
            existingTeams={r.teams}
            onAdded={() => { loadRound(); }}
            lockedClubId={!canManage ? myClubId : null}
          />
        </div>
      )}
    </section>
  );
}
