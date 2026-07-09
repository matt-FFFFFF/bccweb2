// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { Link, useParams, useNavigate } from "react-router";
import type { SeasonSummary, Season } from "@bccweb/types";
import { useBlob } from "../../hooks/useBlob.js";
import { LoadingSpinner, ErrorMessage } from "../../components/LoadingSpinner.js";

export default function League() {
  const { year } = useParams<{ year?: string }>();
  const navigate = useNavigate();

  const { data: seasons, loading: seasonsLoading } =
    useBlob<SeasonSummary[]>("seasons.json");

  // Determine which year to show: URL param → active season → latest
  const activeSeason = seasons?.find((s) => s.active);
  const targetYear =
    year ??
    (activeSeason ? String(activeSeason.year) : seasons?.[0] ? String(seasons[0].year) : null);

  const { data: season, loading: seasonLoading, error } = useBlob<Season>(
    targetYear ? `seasons/${targetYear}.json` : null
  );

  if (seasonsLoading || (targetYear && seasonLoading)) {
    return <LoadingSpinner message="Loading league table…" />;
  }
  if (error) return <ErrorMessage error={error} title="Could not load season" />;
  if (!seasons || seasons.length === 0) {
    return <p>No seasons found.</p>;
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {/* ── Header + season selector ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <h1 style={{ fontSize: "1.75rem", margin: 0 }}>
          {targetYear} League Table
        </h1>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <label htmlFor="season-select" style={{ fontSize: "0.9rem", color: "#555" }}>
            Season:
          </label>
          <select
            id="season-select"
            value={targetYear ?? ""}
            onChange={(e) => navigate(`/results/${e.target.value}`)}
            style={{
              padding: "0.3rem 0.6rem",
              border: "1px solid #dee2e6",
              borderRadius: "0.375rem",
              fontSize: "0.9rem",
            }}
          >
            {seasons.map((s) => (
              <option key={s.year} value={s.year}>
                {s.year}{s.active ? " (active)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Round results link ── */}
      {targetYear && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Link
            to={`/results/${targetYear}/rounds`}
            style={{ color: "#0066cc", fontSize: "0.9rem" }}
          >
            View round-by-round results →
          </Link>
        </div>
      )}

      {/* ── League table ── */}
      {!season ? (
        <p style={{ color: "#888" }}>No data for this season.</p>
      ) : season.leagueTable.length === 0 ? (
        <p style={{ color: "#888" }}>No completed rounds yet this season.</p>
      ) : (
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}
        >
          <thead>
            <tr style={{ borderBottom: "2px solid #dee2e6" }}>
              <th style={{ textAlign: "left", padding: "0.5rem 0.6rem", width: "3rem" }}>#</th>
              <th style={{ textAlign: "left", padding: "0.5rem 0.6rem" }}>Team</th>
              <th style={{ textAlign: "left", padding: "0.5rem 0.6rem" }}>Club</th>
              <th style={{ textAlign: "right", padding: "0.5rem 0.6rem" }}>Rounds</th>
              <th style={{ textAlign: "right", padding: "0.5rem 0.6rem" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {season.leagueTable.map((entry) => (
              <tr
                key={`${entry.clubId}-${entry.teamName}`}
                style={{
                  borderBottom: "1px solid #f0f0f0",
                  background: entry.rank === 1 ? "#fffef0" : undefined,
                }}
              >
                <td
                  style={{
                    padding: "0.5rem 0.6rem",
                    color: entry.rank <= 3 ? "#333" : "#888",
                    fontWeight: entry.rank <= 3 ? 700 : 400,
                  }}
                >
                  {entry.rank}
                </td>
                <td style={{ padding: "0.5rem 0.6rem", fontWeight: 600 }}>
                  {entry.teamName}
                </td>
                <td style={{ padding: "0.5rem 0.6rem", color: "#555" }}>
                  {entry.clubName}
                </td>
                <td style={{ padding: "0.5rem 0.6rem", textAlign: "right", color: "#555" }}>
                  {entry.countedRounds}
                </td>
                <td
                  style={{
                    padding: "0.5rem 0.6rem",
                    textAlign: "right",
                    fontWeight: 700,
                    fontSize: "1.05em",
                  }}
                >
                  {entry.totalScore}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
