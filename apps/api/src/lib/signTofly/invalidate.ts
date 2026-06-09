import type { Round, RoundBrief, Signature } from "@bccweb/types";

export function invalidatePriorSignToFlyFlags(
  round: Round,
  brief: RoundBrief,
  signatures: Signature[],
): Round {
  const currentBriefVersion = (brief as RoundBrief & { version?: number }).version ?? 1;
  const latest = new Map<string, number>();

  for (const signature of signatures) {
    if (signature.briefVersion === null) continue;
    const key = slotKey(signature.teamId, signature.place);
    latest.set(key, Math.max(latest.get(key) ?? 0, signature.briefVersion));
  }

  for (const team of round.teams) {
    for (const slot of team.pilots) {
      const latestVersion = latest.get(slotKey(team.id, slot.placeInTeam));
      if (latestVersion !== undefined && latestVersion < currentBriefVersion) {
        slot.signToFly = false;
      }
    }
  }

  return round;
}

function slotKey(teamId: string, place: number): string {
  return `${teamId}:${place}`;
}
