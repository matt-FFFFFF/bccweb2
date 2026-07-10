// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Pilot, Round, Team } from "@bccweb/types";
import { useAuth } from "../../hooks/useAuth.js";
import { api, ApiError } from "../../lib/api.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { ErrorMessage, LoadingSpinner } from "../../components/LoadingSpinner.js";

interface RegisterResponse {
  roundId: string;
  teamId: string;
  place: number;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function emptyPlaces(team: Team, maxPlace: number): number[] {
  const places: number[] = [];
  for (let place = 1; place <= maxPlace; place += 1) {
    const slot = team.pilots.find((candidate) => candidate.placeInTeam === place);
    if (!slot || slot.status === "Empty" || !slot.pilotId) places.push(place);
  }
  return places;
}

function conflictLink(detail?: string): { id: string; label: string } | null {
  if (!detail) return null;
  const match = /Conflicting round ([^\s]+) on ([0-9-]+)/.exec(detail);
  if (!match) return null;
  return { id: match[1], label: match[2] };
}

export default function RegisterForRound() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { identity } = useAuth();

  const [round, setRound] = useState<Round | null>(null);
  const [pilot, setPilot] = useState<Pilot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id || !identity?.pilotId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      api.get<Round>(`rounds/${id}`),
      api.get<Pilot>(`pilots/${identity.pilotId}`),
    ])
      .then(([roundData, pilotData]) => {
        if (cancelled) return;
        setRound(roundData);
        setPilot(pilotData);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err as Error);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, identity?.pilotId]);

  const pilotClubId = useMemo(() => {
    if (!round || !pilot) return null;
    return pilot.seasonClubs.find((club) => club.seasonYear === round.season.year)?.clubId
      ?? pilot.currentClub?.id
      ?? null;
  }, [pilot, round]);

  const teams = useMemo(() => {
    if (!round || !pilotClubId) return [];
    return round.teams.filter((team) => team.club.id === pilotClubId);
  }, [pilotClubId, round]);

  useEffect(() => {
    if (!selectedTeamId && teams.length > 0) setSelectedTeamId(teams[0].id);
  }, [selectedTeamId, teams]);

  async function submit() {
    if (!id || !selectedTeamId) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post<RegisterResponse>(`rounds/${id}/register-self`, {
        teamId: selectedTeamId,
      });
      navigate(`/rounds/${id}`);
    } catch (err) {
      setError(err as Error);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <LoadingSpinner message="Loading registration…" />;

  if (!identity?.roles.includes("Pilot") || !identity.pilotId) {
    return <p>Round registration is only available to signed-in pilots.</p>;
  }

  if (error instanceof ApiError && error.code === "PROFILE_INCOMPLETE") {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "1.25rem", background: "#fff3cd", borderRadius: "0.5rem" }}>
        <h1>Complete your profile first</h1>
        <p>Complete your profile first, then come back to register for this round.</p>
        <Link to="/profile" style={{ color: "#664d03", fontWeight: 700 }}>Go to profile</Link>
      </div>
    );
  }

  if (!round || !pilot) {
    return error ? <ErrorMessage error={error} title="Could not load registration" /> : null;
  }

  const conflict = error instanceof ApiError && error.code === "DOUBLE_BOOKING"
    ? conflictLink(error.detail)
    : null;
  const registerDisabled = !selectedTeamId || submitting || teams.length === 0;

  return (
    <div style={{ maxWidth: 780, margin: "0 auto" }}>
      <nav style={{ marginBottom: "1rem", fontSize: "0.85rem" }}>
        <Link to={`/rounds/${round.id}`} style={{ color: "#0066cc", textDecoration: "none" }}>Back to round</Link>
      </nav>

      <header style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ margin: "0 0 0.35rem", fontSize: "1.75rem" }}>Register for {round.site.name}</h1>
        <p style={{ margin: 0, color: "#555" }}>{formatDate(round.date)} — {round.season.year} Season</p>
        <div style={{ marginTop: "0.75rem" }}><StatusBadge status={round.status} /></div>
      </header>

      {error instanceof ApiError && error.code === "DOUBLE_BOOKING" && (
        <div style={{ marginBottom: "1rem", padding: "1rem", background: "#f8d7da", color: "#842029", borderRadius: "0.5rem" }}>
          <strong>You are already booked into another round.</strong>
          <p style={{ margin: "0.35rem 0 0" }}>{error.detail}</p>
          {conflict && (
            <Link to={`/rounds/${conflict.id}`} style={{ display: "inline-block", marginTop: "0.75rem", color: "#842029", fontWeight: 700 }}>
              Cancel my booking on {conflict.label} first
            </Link>
          )}
        </div>
      )}
      {error && !(error instanceof ApiError && error.code === "DOUBLE_BOOKING") && (
        <ErrorMessage error={error} title="Could not register" />
      )}

      <section style={{ padding: "1.25rem", border: "1px solid #dee2e6", borderRadius: "0.5rem", background: "#fff" }}>
        <h2 style={{ marginTop: 0, fontSize: "1.15rem" }}>Choose your team</h2>
        {teams.length === 0 ? (
          <p>{pilotClubId
            ? "No teams are available for your club in this round."
            : "Set your club in your profile before registering for a round."}</p>
        ) : (
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {teams.map((team) => {
              const places = emptyPlaces(team, Math.max(5, ...team.pilots.map((slot) => slot.placeInTeam), 1));
              return (
                <label key={team.id} style={{ display: "block", padding: "0.9rem", border: selectedTeamId === team.id ? "2px solid #0066cc" : "1px solid #dee2e6", borderRadius: "0.45rem", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="teamId"
                    value={team.id}
                    checked={selectedTeamId === team.id}
                    onChange={() => setSelectedTeamId(team.id)}
                    style={{ marginRight: "0.6rem" }}
                  />
                  <strong>{team.teamName}</strong>
                  <span style={{ marginLeft: "0.5rem", color: "#666" }}>{places.length} empty slot{places.length === 1 ? "" : "s"}</span>
                </label>
              );
            })}
          </div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={registerDisabled}
          style={{
            marginTop: "1.25rem",
            padding: "0.7rem 1rem",
            background: registerDisabled ? "#adb5bd" : "#0066cc",
            color: "white",
            border: 0,
            borderRadius: "0.35rem",
            fontWeight: 700,
            cursor: submitting ? "wait" : registerDisabled ? "not-allowed" : "pointer",
          }}
        >
          {submitting ? "Registering…" : "Register for this round"}
        </button>
      </section>
    </div>
  );
}
