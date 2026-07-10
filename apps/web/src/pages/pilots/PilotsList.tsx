// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router";
import type { PilotSummary, ClubSummary } from "@bccweb/types";
import { api, ApiError } from "../../lib/api.js";
import { LoadingSpinner, ErrorMessage } from "../../components/LoadingSpinner.js";
import { useBlob } from "../../hooks/useBlob.js";

export default function PilotsList() {
  const { data: clubs } = useBlob<ClubSummary[]>("clubs.json");
  const clubNameById = useMemo(() => new Map((clubs ?? []).map((c) => [c.id, c.name])), [clubs]);

  const [pilots, setPilots] = useState<PilotSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<PilotSummary[]>("pilots")
      .then((data) => {
        if (!cancelled) {
          setPilots(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : "Could not load pilots"
          );
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <LoadingSpinner message="Loading pilots…" />;
  if (error) return <ErrorMessage error={new Error(error)} title="Could not load pilots" />;
  if (!pilots || pilots.length === 0) return <p>No pilots found.</p>;

  const filtered = search.trim()
    ? pilots.filter((p) =>
        p.name.toLowerCase().includes(search.toLowerCase())
      )
    : pilots;

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", marginTop: 0 }}>Pilots</h1>

      <div style={{ marginBottom: "1rem" }}>
        <input
          type="search"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: "0.4rem 0.75rem",
            border: "1px solid #dee2e6",
            borderRadius: "0.375rem",
            fontSize: "0.9rem",
            width: "100%",
            maxWidth: 350,
          }}
        />
        <span style={{ marginLeft: "0.75rem", color: "#888", fontSize: "0.85rem" }}>
          {filtered.length} pilot{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      <table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}
      >
        <thead>
          <tr style={{ borderBottom: "2px solid #dee2e6" }}>
            <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Name</th>
            <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Club</th>
            <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Rating</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td style={{ padding: "0.5rem 0.5rem" }}>
                <Link
                  to={`/pilots/${p.id}`}
                  style={{ color: "#0066cc", textDecoration: "none", fontWeight: 500 }}
                >
                  {p.name}
                </Link>
              </td>
              <td style={{ padding: "0.5rem 0.5rem", color: "#555" }}>
                {p.clubId ? (clubNameById.get(p.clubId) ?? p.clubId) : "—"}
              </td>
              <td style={{ padding: "0.5rem 0.5rem", color: "#555" }}>
                {p.rating ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
