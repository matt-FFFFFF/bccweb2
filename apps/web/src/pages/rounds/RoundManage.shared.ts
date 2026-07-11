// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { PilotSummary } from "@bccweb/types";
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
