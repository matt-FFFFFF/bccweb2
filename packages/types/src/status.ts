import type { RoundStatus } from "./index.js";

/**
 * Roster (teams, pilots, captains) is editable only before brief-complete.
 * At BriefComplete the roster is snapshotted into the brief and frozen — the
 * coordinator must Reopen the brief to edit it; Locked/Complete/Cancelled stay
 * frozen too.
 */
export function isRosterFrozen(status: RoundStatus): boolean {
  return status !== "Proposed" && status !== "Confirmed";
}

/**
 * Status-accurate remediation clause for a frozen-roster rejection. "Reopen the
 * brief" only applies at BriefComplete; a Cancelled round must be uncancelled,
 * and Locked/Complete rounds cannot be reopened at all.
 */
export function rosterFrozenReason(status: RoundStatus): string {
  if (status === "Cancelled") return "the round is cancelled (uncancel it first)";
  if (status === "Locked" || status === "Complete") {
    return `the round is ${status.toLowerCase()}`;
  }
  return "the brief is complete (reopen the brief first)";
}

export function normalizeStatus(raw: string): RoundStatus {
  const value = raw.trim();

  switch (value.toLowerCase()) {
    case "submitted":
      return "Proposed";
    case "verified":
      return "Confirmed";
    case "brief complete":
    case "briefcomplete":
      return "BriefComplete";
    case "deleted":
      return "Cancelled";
    default:
      if (
        value === "Proposed" ||
        value === "Confirmed" ||
        value === "BriefComplete" ||
        value === "Locked" ||
        value === "Complete" ||
        value === "Cancelled"
      ) {
        return value;
      }
      throw new Error(`Unknown status: ${raw}`);
  }
}
