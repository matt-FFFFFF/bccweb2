// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { Link } from "react-router";
import type { Round } from "@bccweb/types";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatDate, btnStyle } from "./RoundManage.shared.js";

export function RoundManageHeader({
  r,
  canManage,
  pollTimeout,
  ptPollTimeout,
  regeneratePdf,
  recreatePureTrack,
}: {
  r: Round;
  canManage: boolean;
  pollTimeout: number | null;
  ptPollTimeout: number | null;
  regeneratePdf: () => void;
  recreatePureTrack: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "1rem",
        marginBottom: "1.5rem",
      }}
    >
      <div>
        <h1 style={{ fontSize: "1.75rem", margin: "0 0 0.25rem" }}>
          {r.site.name}
        </h1>
        <p style={{ margin: 0, color: "#555" }}>
          {formatDate(r.date)} — {r.season.year} Season
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.5rem" }}>
        <StatusBadge status={r.status} />
        {canManage && (r.status === "Locked" || r.status === "Complete") && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", alignItems: "flex-end" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {r.brief?.pdfStatus === "pending" && pollTimeout === null && (
                <span style={{ fontSize: "0.82rem", color: "#664d03", display: "flex", alignItems: "center", gap: "0.3rem" }}>
                  <span style={{ display: "inline-block", width: "0.8rem", height: "0.8rem", border: "2px solid #dee2e6", borderTopColor: "currentColor", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                  PDF Queued…
                </span>
              )}
              {r.brief?.pdfStatus === "processing" && pollTimeout === null && (
                <span style={{ fontSize: "0.82rem", color: "#084298", display: "flex", alignItems: "center", gap: "0.3rem" }}>
                  <span style={{ display: "inline-block", width: "0.8rem", height: "0.8rem", border: "2px solid #dee2e6", borderTopColor: "currentColor", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                  Generating PDF…
                </span>
              )}
              {r.brief?.pdfStatus === "failed" && (
                <span style={{ fontSize: "0.82rem", color: "#842029" }}>
                  Failed to generate PDF
                </span>
              )}
              {pollTimeout !== null && (r.brief?.pdfStatus === "pending" || r.brief?.pdfStatus === "processing") && (
                <span style={{ fontSize: "0.82rem", color: "#842029" }}>
                  PDF taking longer than expected — Refresh/Regenerate
                </span>
              )}

              {r.brief?.pdfStatus === "failed" || (pollTimeout !== null && (r.brief?.pdfStatus === "pending" || r.brief?.pdfStatus === "processing")) ? (
                <button
                  onClick={() => { regeneratePdf(); }}
                  style={{ ...btnStyle("#58151c", "#f8d7da"), fontSize: "0.82rem" }}
                >
                  Regenerate PDF
                </button>
              ) : null}

              {r.brief?.pdfStatus === "ready" || !r.brief?.pdfStatus ? (
                <Link
                  to={`/rounds/${r.id}/brief`}
                  style={{
                    padding: "0.35rem 0.75rem",
                    background: "#e8edf8",
                    color: "#1a4fa0",
                    border: "1px solid #c8cce0",
                    borderRadius: "0.3rem",
                    textDecoration: "none",
                    fontSize: "0.82rem",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                >
                  View Brief
                </Link>
              ) : (
                <span
                  style={{
                    padding: "0.35rem 0.75rem",
                    background: "#e9ecef",
                    color: "#6c757d",
                    border: "1px solid #dee2e6",
                    borderRadius: "0.3rem",
                    fontSize: "0.82rem",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    cursor: "not-allowed",
                  }}
                  title={r.brief?.pdfStatus === "pending" || r.brief?.pdfStatus === "processing" ? "PDF is generating" : "PDF generation failed"}
                >
                  View Brief
                </span>
              )}
            </div>
            
            {(r.pureTrack?.status || ptPollTimeout !== null) && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                {r.pureTrack?.status === "pending" && ptPollTimeout === null && (
                  <span style={{ fontSize: "0.82rem", color: "#664d03", display: "flex", alignItems: "center", gap: "0.3rem" }}>
                    <span style={{ display: "inline-block", width: "0.8rem", height: "0.8rem", border: "2px solid #dee2e6", borderTopColor: "currentColor", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                    PureTrack Queued…
                  </span>
                )}
                {r.pureTrack?.status === "processing" && ptPollTimeout === null && (
                  <span style={{ fontSize: "0.82rem", color: "#084298", display: "flex", alignItems: "center", gap: "0.3rem" }}>
                    <span style={{ display: "inline-block", width: "0.8rem", height: "0.8rem", border: "2px solid #dee2e6", borderTopColor: "currentColor", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                    Creating PureTrack Groups…
                  </span>
                )}
                {r.pureTrack?.status === "failed" && (
                  <span style={{ fontSize: "0.82rem", color: "#842029" }}>
                    PureTrack Group Creation Failed
                  </span>
                )}
                {ptPollTimeout !== null && (r.pureTrack?.status === "pending" || r.pureTrack?.status === "processing") && (
                  <span style={{ fontSize: "0.82rem", color: "#842029" }}>
                    PureTrack taking longer than expected — Refresh/Recreate
                  </span>
                )}
                {r.pureTrack?.status === "ready" && (
                  <span style={{ fontSize: "0.82rem", color: "#0f5132" }}>
                    PureTrack Groups Ready
                  </span>
                )}

                {r.pureTrack?.status === "failed" || (ptPollTimeout !== null && (r.pureTrack?.status === "pending" || r.pureTrack?.status === "processing")) ? (
                  <button
                    onClick={() => { recreatePureTrack(); }}
                    style={{ ...btnStyle("#58151c", "#f8d7da"), fontSize: "0.82rem" }}
                  >
                    Recreate Groups
                  </button>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
