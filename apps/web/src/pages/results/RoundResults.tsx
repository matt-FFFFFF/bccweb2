import { Link, useParams, useNavigate } from "react-router";
import type { SeasonSummary, SeasonResults } from "@bccweb/types";
import { useBlob } from "../../hooks/useBlob.js";
import { LoadingSpinner, ErrorMessage } from "../../components/LoadingSpinner.js";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function RoundResults() {
  const { year } = useParams<{ year: string }>();
  const navigate = useNavigate();

  const { data: seasons } = useBlob<SeasonSummary[]>("seasons.json");
  const { data: results, loading, error } = useBlob<SeasonResults>(
    year ? `results/${year}.json` : null
  );

  if (loading) return <LoadingSpinner message="Loading results…" />;
  if (error) return <ErrorMessage error={error} title="Could not load results" />;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      {/* ── Header ── */}
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
        <div>
          <nav style={{ fontSize: "0.85rem", color: "#888", marginBottom: "0.4rem" }}>
            <Link to={`/results/${year ?? ""}`} style={{ color: "#0066cc", textDecoration: "none" }}>
              {year} League
            </Link>{" "}
            / Round Results
          </nav>
          <h1 style={{ fontSize: "1.75rem", margin: 0 }}>
            {year} Round Results
          </h1>
        </div>
        {seasons && (
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <label htmlFor="season-select" style={{ fontSize: "0.9rem", color: "#555" }}>
              Season:
            </label>
            <select
              id="season-select"
              value={year ?? ""}
              onChange={(e) => navigate(`/results/${e.target.value}/rounds`)}
              style={{
                padding: "0.3rem 0.6rem",
                border: "1px solid #dee2e6",
                borderRadius: "0.375rem",
                fontSize: "0.9rem",
              }}
            >
              {seasons.map((s) => (
                <option key={s.year} value={s.year}>
                  {s.year}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ── Results ── */}
      {!results || results.length === 0 ? (
        <p style={{ color: "#888" }}>No completed rounds yet.</p>
      ) : (
        results.map((roundResult) => (
          <section key={roundResult.roundId} style={{ marginBottom: "2.5rem" }}>
            <h2
              style={{
                fontSize: "1.1rem",
                marginBottom: "0.75rem",
                paddingBottom: "0.4rem",
                borderBottom: "1px solid #dee2e6",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <Link
                to={`/rounds/${roundResult.roundId}`}
                style={{ color: "#0066cc", textDecoration: "none" }}
              >
                {roundResult.siteName}
              </Link>
              <span style={{ color: "#888", fontSize: "0.85em", fontWeight: 400 }}>
                {formatDate(roundResult.date)}
              </span>
            </h2>

            {roundResult.teamResults.map((team, idx) => (
              <details
                key={`${roundResult.roundId}-${team.teamName}`}
                open={idx === 0}
                style={{ marginBottom: "0.75rem" }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    padding: "0.5rem 0.6rem",
                    background: "#f8f9fa",
                    borderRadius: "0.375rem",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    listStyle: "none",
                    userSelect: "none",
                  }}
                >
                  <span>
                    <strong style={{ marginRight: "0.5rem" }}>#{team.rank}</strong>
                    {team.teamName}
                    <span style={{ color: "#888", fontSize: "0.85em", marginLeft: "0.4rem" }}>
                      {team.clubName}
                    </span>
                  </span>
                  <strong>{team.score} pts</strong>
                </summary>
                {team.pilots.length > 0 && (
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: "0.85rem",
                      marginTop: "0.25rem",
                    }}
                  >
                    <tbody>
                      {team.pilots
                        .slice()
                        .sort((a, b) => b.score - a.score)
                        .map((pilot, pi) => (
                          <tr
                            key={pi}
                            style={{ borderBottom: "1px solid #f5f5f5" }}
                          >
                            <td style={{ padding: "0.35rem 0.6rem", color: "#555" }}>
                              {pilot.pilotName}
                            </td>
                            <td
                              style={{
                                padding: "0.35rem 0.6rem",
                                color: "#888",
                                textAlign: "right",
                                fontSize: "0.8em",
                              }}
                            >
                              {pilot.wingClass}
                            </td>
                            <td
                              style={{
                                padding: "0.35rem 0.6rem",
                                textAlign: "right",
                                color: "#555",
                              }}
                            >
                              {pilot.distance} km
                            </td>
                            <td
                              style={{
                                padding: "0.35rem 0.6rem",
                                textAlign: "right",
                                fontWeight: 600,
                                color: "#0a3622",
                              }}
                            >
                              {pilot.score.toFixed(1)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </details>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
