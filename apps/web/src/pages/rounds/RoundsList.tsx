// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { Link } from "react-router";
import type { RoundSummary } from "@bccweb/types";
import { useBlob } from "../../hooks/useBlob.js";
import { useAuth } from "../../hooks/useAuth.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { LoadingSpinner, ErrorMessage } from "../../components/LoadingSpinner.js";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const STATUS_ORDER: Record<string, number> = {
  Locked: 0,
  BriefComplete: 1,
  Confirmed: 2,
  Proposed: 3,
  Complete: 4,
  Cancelled: 5,
};

export default function RoundsList() {
  const { data: rounds, loading, error } = useBlob<RoundSummary[]>("rounds.json");
  const { identity } = useAuth();

  const isCoord =
    identity?.roles.includes("RoundsCoord") ||
    identity?.roles.includes("Admin");

  if (loading) return <LoadingSpinner message="Loading rounds…" />;
  if (error) return <ErrorMessage error={error} title="Could not load rounds" />;
  if (!rounds || rounds.length === 0) {
    return <p>No rounds found.</p>;
  }

  // Drop malformed entries: a round missing seasonYear would key bySeason as
  // "undefined", then Number("undefined")=NaN, then bySeason[NaN] crashes .sort().
  const validRounds = rounds.filter(
    (r) => typeof r?.seasonYear === "number" && typeof r?.date === "string" && typeof r?.status === "string",
  );
  if (validRounds.length === 0) {
    return <p>No rounds found.</p>;
  }

  // Group by season year, sort within each group by date desc
  const bySeason: Record<number, RoundSummary[]> = {};
  for (const r of validRounds) {
    if (!bySeason[r.seasonYear]) bySeason[r.seasonYear] = [];
    bySeason[r.seasonYear].push(r);
  }

  const years = Object.keys(bySeason)
    .map(Number)
    .sort((a, b) => b - a);

  for (const year of years) {
    bySeason[year].sort((a, b) => {
      const statusDiff =
        (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
      if (statusDiff !== 0) return statusDiff;
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <h1 style={{ fontSize: "1.75rem", margin: 0 }}>Rounds</h1>
        {isCoord && (
          <Link
            to="/rounds/new"
            style={{
              padding: "0.4rem 0.9rem",
              background: "#0066cc",
              color: "#fff",
              borderRadius: "0.35rem",
              textDecoration: "none",
              fontWeight: 600,
              fontSize: "0.875rem",
            }}
          >
            + Create Round
          </Link>
        )}
      </div>

      {years.map((year) => (
        <section key={year} style={{ marginBottom: "2rem" }}>
          <h2
            style={{
              fontSize: "1.1rem",
              marginBottom: "0.75rem",
              color: "#555",
              borderBottom: "1px solid #dee2e6",
              paddingBottom: "0.4rem",
            }}
          >
            {year} Season
          </h2>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.9rem",
            }}
          >
            <thead>
              <tr style={{ borderBottom: "2px solid #dee2e6" }}>
                <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Date</th>
                <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Site</th>
                <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Status</th>
                {isCoord && <th style={{ padding: "0.4rem 0.5rem" }} />}
              </tr>
            </thead>
            <tbody>
              {bySeason[year].map((r) => (
                <tr
                  key={r.id}
                  style={{ borderBottom: "1px solid #f0f0f0" }}
                >
                  <td style={{ padding: "0.5rem 0.5rem", whiteSpace: "nowrap" }}>
                    {formatDate(r.date)}
                  </td>
                  <td style={{ padding: "0.5rem 0.5rem" }}>
                    <Link
                      to={`/rounds/${r.id}`}
                      style={{ color: "#0066cc", textDecoration: "none", fontWeight: 500 }}
                    >
                      {r.siteName}
                    </Link>
                  </td>
                  <td style={{ padding: "0.5rem 0.5rem" }}>
                    <StatusBadge status={r.status} />
                  </td>
                  {isCoord && (
                    <td style={{ padding: "0.5rem 0.5rem", textAlign: "right" }}>
                      <Link
                        to={`/rounds/${r.id}/manage`}
                        style={{ color: "#555", fontSize: "0.8rem", textDecoration: "none" }}
                      >
                        Manage
                      </Link>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
