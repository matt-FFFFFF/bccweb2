import type { RoundStatus } from "./index.js";

/** Round statuses in which the roster (teams, pilots, captains) is frozen. */
export type FrozenRoundStatus = Exclude<RoundStatus, "Proposed" | "Confirmed">;

/**
 * Roster (teams, pilots, captains) is editable only before brief-complete.
 * At BriefComplete the roster is snapshotted into the brief and frozen — the
 * coordinator must Reopen the brief to edit it; Locked/Complete/Cancelled stay
 * frozen too.
 */
export function isRosterFrozen(status: RoundStatus): status is FrozenRoundStatus {
  return status !== "Proposed" && status !== "Confirmed";
}

/**
 * Status-accurate remediation clause for a frozen-roster rejection. "Reopen the
 * brief" only applies at BriefComplete; a Cancelled round must be uncancelled,
 * and Locked/Complete rounds cannot be reopened at all. The parameter is a
 * FrozenRoundStatus so this can only be called behind an isRosterFrozen guard.
 */
export function rosterFrozenReason(status: FrozenRoundStatus): string {
  switch (status) {
    case "Cancelled":
      return "the round is cancelled (uncancel it first)";
    case "Locked":
    case "Complete":
      return `the round is ${status.toLowerCase()}`;
    case "BriefComplete":
      return "the brief is complete (reopen the brief first)";
  }
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
