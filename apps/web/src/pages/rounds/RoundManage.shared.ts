// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { PilotSummary, RoundStatus } from "@bccweb/types";
import type React from "react";

export function pilotDisplayName(pilotId: string | null, index: PilotSummary[] | null): string {
  if (!pilotId) return "Empty";
  return index?.find((p) => p.id === pilotId)?.name ?? pilotId;
}

export const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #ccc",
  borderRadius: "0.3rem",
  fontSize: "0.875rem",
  boxSizing: "border-box",
};

export const btnStyle = (
  color: string,
  bg: string
): React.CSSProperties => ({
  padding: "0.35rem 0.75rem",
  background: bg,
  color,
  border: "none",
  borderRadius: "0.3rem",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: "0.8rem",
  whiteSpace: "nowrap",
});

export const sectionStyle: React.CSSProperties = {
  marginBottom: "2rem",
  padding: "1rem",
  border: "1px solid #dee2e6",
  borderRadius: "0.5rem",
};

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}


export const WORKFLOW: Record<
  RoundStatus,
  Array<{ label: string; endpoint: string; bg: string; color: string; requiresConfirm?: boolean }>
> = {
  Proposed: [
    { label: "Confirm", endpoint: "confirm", bg: "#cfe2ff", color: "#084298" },
    { label: "Cancel Round", endpoint: "cancel", bg: "#f8d7da", color: "#58151c" },
  ],
  Confirmed: [
    {
      label: "Mark Brief Complete",
      endpoint: "brief-complete",
      bg: "#d0d0ff",
      color: "#3a00a8",
      requiresConfirm: true,
    },
    { label: "Cancel Round", endpoint: "cancel", bg: "#f8d7da", color: "#58151c" },
  ],
  BriefComplete: [
    {
      label: "Lock Round",
      endpoint: "lock",
      bg: "#fff3cd",
      color: "#664d03",
    },
    {
      label: "Reopen Brief",
      endpoint: "reopen",
      bg: "#e9ecef",
      color: "#495057",
      requiresConfirm: true,
    }
  ],
  Locked: [
    {
      label: "Complete Round",
      endpoint: "complete",
      bg: "#d1e7dd",
      color: "#0a3622",
    },
    {
      label: "Unlock",
      endpoint: "unlock",
      bg: "#e9ecef",
      color: "#495057",
    },
  ],
  Complete: [],
  Cancelled: [
    { label: "Uncancel", endpoint: "uncancel", bg: "#e9ecef", color: "#495057" },
  ],
};
