import type { Round, RoundBrief, Signature } from "@bccweb/types";

export function materializeSignToFly(
  round: Round,
  brief: RoundBrief & { version?: number },
  signatures: Signature[],
): boolean {
  const currentBriefVersion = brief.version ?? 1;
  const latest = new Map<string, number>();

  for (const signature of signatures) {
    if (signature.briefVersion === null) continue;
    const key = slotKey(signature.teamId, signature.place);
    latest.set(key, Math.max(latest.get(key) ?? 0, signature.briefVersion));
  }

  let changed = false;
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      const latestVersion = latest.get(slotKey(team.id, slot.placeInTeam));
      const next = latestVersion !== undefined && latestVersion === currentBriefVersion;
      if (slot.signToFly !== next) {
        slot.signToFly = next;
        changed = true;
      }
    }
  }

  return changed;
}

function slotKey(teamId: string, place: number): string {
  return `${teamId}:${place}`;
}
