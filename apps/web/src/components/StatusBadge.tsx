// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { RoundStatus, SiteStatus } from "@bccweb/types";

type BadgeStatus = RoundStatus | SiteStatus;

const STATUS_STYLES: Record<BadgeStatus, { bg: string; color: string }> = {
  Proposed:      { bg: "#e9ecef", color: "#495057" },
  Confirmed:     { bg: "#cfe2ff", color: "#084298" },
  BriefComplete: { bg: "#d0d0ff", color: "#3a00a8" },
  Locked:        { bg: "#fff3cd", color: "#664d03" },
  Complete:      { bg: "#d1e7dd", color: "#0a3622" },
  Cancelled:     { bg: "#f8d7da", color: "#58151c" },
  Active:        { bg: "#d1e7dd", color: "#0a3622" },
  Inactive:      { bg: "#e9ecef", color: "#495057" },
};

interface StatusBadgeProps {
  status: BadgeStatus;
  label?: string;
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const style = STATUS_STYLES[status] ?? { bg: "#e9ecef", color: "#495057" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.2em 0.6em",
        borderRadius: "0.25rem",
        fontSize: "0.8em",
        fontWeight: 600,
        backgroundColor: style.bg,
        color: style.color,
        whiteSpace: "nowrap",
      }}
    >
      {label ?? status}
    </span>
  );
}
