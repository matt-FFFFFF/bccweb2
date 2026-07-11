// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { Link } from "react-router";
import type { PilotSummary } from "@bccweb/types";

export function PilotName({
  pilotId,
  index,
}: {
  pilotId: string | null;
  index: PilotSummary[] | null;
}) {
  if (!pilotId) return <span style={{ color: "#aaa" }}>Empty</span>;
  const found = index?.find((p) => p.id === pilotId);
  if (!found)
    return (
      <span style={{ fontFamily: "monospace", fontSize: "0.8em" }}>
        {pilotId}
      </span>
    );
  return (
    <Link
      to={`/pilots/${found.id}`}
      style={{ color: "#0066cc", textDecoration: "none" }}
    >
      {found.name}
    </Link>
  );
}
