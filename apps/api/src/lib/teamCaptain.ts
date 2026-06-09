import type { Team } from "@bccweb/types";

/**
 * Pure captain recomputation — given the current state of a team (after a
 * slot mutation has already been applied), return the team with
 * captainPilotId correctly set.
 *
 * Rules:
 * - Place 1 is filled AND captainPilotId is null → auto-set to that pilotId.
 * - Place 1 is empty → reassign to next-lowest filled slot's pilotId, or null.
 * - Place 1 is filled AND captainPilotId is already non-null → no change
 *   (operator may have manually chosen a different captain).
 *
 * No side effects. Safe to call from any mutation handler (slot add, remove,
 * or the T26 register-self path).
 */
export function recomputeTeamCaptain(team: Team): Team {
  const place1 = team.pilots.find(
    (s) => s.placeInTeam === 1 && s.status === "Filled" && s.pilotId !== null,
  );

  if (place1) {
    // Place 1 is occupied.
    if (team.captainPilotId == null) {
      // Auto-assign: no captain yet, promote place-1 pilot.
      return { ...team, captainPilotId: place1.pilotId };
    }
    // Captain already set by operator — leave alone.
    return team;
  }

  // Place 1 is empty — find next-lowest filled slot.
  const sorted = team.pilots
    .filter((s) => s.status === "Filled" && s.pilotId !== null)
    .sort((a, b) => a.placeInTeam - b.placeInTeam);

  return { ...team, captainPilotId: sorted[0]?.pilotId ?? null };
}
