import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import DOMPurify from "dompurify";
import { api, ApiError } from "../../lib/api.js";
import { useAuth } from "../../hooks/useAuth.js";
import { LoadingSpinner, ErrorMessage } from "../../components/LoadingSpinner.js";
import type { SignToFlyWording, Round, RoundBrief } from "@bccweb/types";

export default function SignToFly() {
  const { roundId, teamId, place } = useParams<{ roundId: string; teamId: string; place: string }>();
  const { identity } = useAuth();

  const [wording, setWording] = useState<SignToFlyWording | null>(null);
  const [brief, setBrief] = useState<RoundBrief & { version?: number } | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [signature, setSignature] = useState<{ signedAt: string; briefVersion: number | null; wordingVersion: number | null } | null>(null);

  useEffect(() => {
    if (!roundId || !teamId || !place) return;
    
    let cancelled = false;
    setLoading(true);

    Promise.all([
      api.get<SignToFlyWording>("sign-to-fly/wording/active"),
      api.get<RoundBrief & { version?: number }>(`rounds/${roundId}/brief`),
      api.get<Round>(`rounds/${roundId}`)
    ])
      .then(([wData, bData, rData]) => {
        if (!cancelled) {
          setWording(wData);
          setBrief(bData);
          setRound(rData);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoading(false);
          setError(err as Error);
        }
      });

    return () => { cancelled = true; };
  }, [roundId, teamId, place]);

  const handleSubmit = async () => {
    if (!roundId || !teamId || !place) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<{ signedAt: string; briefVersion: number | null; wordingVersion: number | null }>(
        `rounds/${roundId}/teams/${teamId}/pilots/${place}/sign`,
        {}
      );
      setSignature(res);
    } catch (err) {
      setError(err as Error);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <LoadingSpinner message="Loading..." />;
  
  if (error) {
    if (error instanceof ApiError) {
      if (error.code === "NOT_YOUR_SLOT") {
        return (
          <div style={{ maxWidth: 600, margin: "2rem auto", padding: "1.5rem", background: "#f8d7da", color: "#842029", borderRadius: "0.5rem" }}>
            <h2>Cannot Sign</h2>
            <p>This slot is not yours — sign-to-fly is for the pilot assigned to slot {place}.</p>
            <Link to={`/rounds/${roundId}`} style={{ display: "inline-block", marginTop: "1rem", color: "#842029", fontWeight: "bold" }}>Back to round</Link>
          </div>
        );
      }
      if (error.code === "INVALID_STATE") {
        return (
          <div style={{ maxWidth: 600, margin: "2rem auto", padding: "1.5rem", background: "#fff3cd", color: "#842029", borderRadius: "0.5rem" }}>
            <h2>Round Not Ready</h2>
            <p>This round is not yet ready for sign-to-fly. The briefing has to be marked complete first. Current status: {error.detail || "Unknown"}.</p>
            <Link to={`/rounds/${roundId}`} style={{ display: "inline-block", marginTop: "1rem", color: "#842029", fontWeight: "bold" }}>Back to round</Link>
          </div>
        );
      }
      if (error.code === "SLOT_EMPTY") {
        return (
          <div style={{ maxWidth: 600, margin: "2rem auto", padding: "1.5rem", background: "#e2e3e5", color: "#41464c", borderRadius: "0.5rem" }}>
            <h2>Empty Slot</h2>
            <p>This slot is currently empty.</p>
            <Link to={`/rounds/${roundId}`} style={{ display: "inline-block", marginTop: "1rem", color: "#41464c", fontWeight: "bold" }}>Back to round</Link>
          </div>
        );
      }
    }
    return <ErrorMessage error={error} title="Could not load" />;
  }

  if (!wording || !brief || !round) return null;

  const team = round.teams.find(t => t.id === teamId);
  const briefTeam = brief.teams.find(t => t.teamName === team?.teamName);
  const briefPilot = briefTeam?.pilots.find(p => String(p.placeInTeam) === place);
  const pilotName = briefPilot?.name || "Unknown Pilot";

  if (signature) {
    return (
      <div style={{ maxWidth: 600, margin: "2rem auto", padding: "2rem", background: "#d1e7dd", color: "#0f5132", borderRadius: "0.5rem", textAlign: "center" }}>
        <h2>Signed Successfully</h2>
        <p>You have successfully signed to fly for this round.</p>
        <div style={{ margin: "1.5rem 0", padding: "1rem", background: "rgba(255,255,255,0.5)", borderRadius: "0.3rem", textAlign: "left" }}>
          <p><strong>Signed at:</strong> {new Date(signature.signedAt).toLocaleString()}</p>
          <p><strong>Brief version:</strong> {signature.briefVersion}</p>
          <p><strong>Wording version:</strong> {signature.wordingVersion}</p>
        </div>
        <Link to={`/rounds/${roundId}`} style={{ display: "inline-block", padding: "0.5rem 1rem", background: "#0f5132", color: "white", textDecoration: "none", borderRadius: "0.3rem", fontWeight: "bold" }}>
          Back to round
        </Link>
      </div>
    );
  }

  const sanitizedHtml = DOMPurify.sanitize(wording.html, {
    ALLOWED_TAGS: ["p", "strong", "em", "ul", "ol", "li", "br", "h2", "h3", "span"],
    ALLOWED_ATTR: []
  });

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", paddingBottom: "3rem" }}>
      <nav style={{ marginBottom: "1.5rem", fontSize: "0.85rem", color: "#888" }}>
        <Link to={`/rounds/${roundId}`} style={{ color: "#0066cc", textDecoration: "none" }}>
          Back to Round
        </Link>
      </nav>

      <div style={{ background: "#f8f9fa", border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "1.5rem", marginBottom: "2rem" }}>
        <h1 style={{ margin: "0 0 0.5rem 0", fontSize: "1.5rem" }}>Sign to Fly</h1>
        <p style={{ margin: 0, color: "#555" }}>
          <strong>Pilot:</strong> {pilotName}<br/>
          <strong>Team:</strong> {team?.teamName || "Unknown"}<br/>
          <strong>Date:</strong> {new Date(round.date).toLocaleDateString()}
        </p>
      </div>

      <div style={{ marginBottom: "2rem", lineHeight: 1.6, color: "#333" }} dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />

      <div style={{ background: "#fff", border: "2px solid #e9ecef", borderRadius: "0.5rem", padding: "1.5rem" }}>
        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem", cursor: "pointer" }}>
          <input 
            type="checkbox" 
            checked={checked} 
            onChange={(e) => setChecked(e.target.checked)} 
            style={{ width: "1.2rem", height: "1.2rem", marginTop: "0.2rem" }}
          />
          <span style={{ fontWeight: 600, fontSize: "1.1rem" }}>
            I have read and understood the safety briefing and legal acceptance text above
          </span>
        </label>

        <button 
          onClick={handleSubmit} 
          disabled={!checked || submitting}
          style={{ 
            marginTop: "1.5rem", 
            width: "100%", 
            padding: "0.8rem", 
            fontSize: "1.1rem", 
            fontWeight: "bold", 
            background: checked ? "#0a3622" : "#ccc", 
            color: "white", 
            border: "none", 
            borderRadius: "0.3rem",
            cursor: checked && !submitting ? "pointer" : "not-allowed"
          }}
        >
          {submitting ? "Submitting..." : "Sign to Fly"}
        </button>
      </div>
    </div>
  );
}
