// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { RescoreJob, RescoreJobStatus, Round } from "@bccweb/types";
import { useAuth } from "../../../hooks/useAuth.js";
import { api, ApiError } from "../../../lib/api.js";

/** Poll cadence and cap: every 3 s, up to ~100 polls (~5 minutes) then surface a
 * "still running" state instead of spinning forever. */
const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS = 100;

/** The enqueue→poll lifecycle as an explicit state machine. */
type Phase =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "enqueuing" }
  | { kind: "polling"; jobId: string }
  | { kind: "success"; job: RescoreJob }
  | { kind: "error"; message: string }
  | { kind: "timeout"; jobId: string };

interface RescoreRoundButtonProps {
  round: Round;
  onChanged: () => void;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
};

const cardStyle: CSSProperties = {
  background: "#fff",
  padding: "1.5rem",
  borderRadius: "0.5rem",
  maxWidth: "440px",
  width: "100%",
  boxShadow: "0 10px 40px rgba(0,0,0,0.35)",
};

function btnStyle(color: string, bg: string): CSSProperties {
  return {
    padding: "0.5rem 1rem",
    background: bg,
    color,
    border: 0,
    borderRadius: "0.3rem",
    fontWeight: 600,
    fontSize: "0.85rem",
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

function errMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "RESCORE_IN_PROGRESS") {
      return "A re-score is already running for this round. Wait for it to finish, then try again.";
    }
    return err.detail ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return "Unexpected error while re-scoring.";
}

export function RescoreRoundButton({ round, onChanged }: RescoreRoundButtonProps) {
  const { identity } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const mountedRef = useRef(true);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Clean up the poll interval on unmount so no timer leaks after the component
  // goes away mid-rescore.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const pollOnce = useCallback(
    async (jobId: string) => {
      pollCountRef.current += 1;
      let job: RescoreJob;
      try {
        job = await api.get<RescoreJob>(`rounds/${round.id}/rescore/${jobId}`);
      } catch (err) {
        stopPolling();
        if (mountedRef.current) setPhase({ kind: "error", message: errMessage(err) });
        return;
      }
      if (!mountedRef.current) return;

      if (job.status === "completed" || job.status === "partial") {
        stopPolling();
        setPhase({ kind: "success", job });
        onChanged();
        return;
      }
      if (job.status === "failed") {
        stopPolling();
        const first = job.errors?.[0]?.error;
        setPhase({ kind: "error", message: first ?? "Re-score failed. Check the round and try again." });
        return;
      }
      // queued / running → keep polling until the cap, then surface "still running".
      if (pollCountRef.current >= MAX_POLLS) {
        stopPolling();
        setPhase({ kind: "timeout", jobId });
      }
    },
    [round.id, onChanged, stopPolling],
  );

  const onConfirm = useCallback(async () => {
    setPhase({ kind: "enqueuing" });
    let jobId: string;
    try {
      const res = await api.post<{ jobId: string; status: RescoreJobStatus }>(
        `rounds/${round.id}/rescore`,
      );
      jobId = res.jobId;
    } catch (err) {
      if (mountedRef.current) setPhase({ kind: "error", message: errMessage(err) });
      return;
    }
    if (!mountedRef.current) return;
    pollCountRef.current = 0;
    setPhase({ kind: "polling", jobId });
    stopPolling();
    intervalRef.current = setInterval(() => {
      void pollOnce(jobId);
    }, POLL_INTERVAL_MS);
  }, [round.id, pollOnce, stopPolling]);

  const close = useCallback(() => {
    stopPolling();
    setPhase({ kind: "idle" });
  }, [stopPolling]);

  const canRescore =
    (identity?.roles.includes("Admin") ?? false) &&
    (round.status === "Locked" || round.status === "Complete");
  if (!canRescore) return null;

  const igcCount = round.teams
    .flatMap((t) => t.pilots)
    .filter((p) => p.flight?.igcPath).length;

  const busy = phase.kind === "enqueuing" || phase.kind === "polling";

  return (
    <section style={{ margin: "1.5rem 0" }}>
      <button
        type="button"
        data-testid="rescore-round-btn"
        onClick={() => setPhase({ kind: "confirming" })}
        disabled={busy}
        style={btnStyle("#fff", "#0a3622")}
      >
        Re-score round
      </button>

      {phase.kind === "confirming" && (
        <div style={overlayStyle}>
          <div style={cardStyle} role="dialog" aria-modal="true" data-testid="rescore-confirm-dialog">
            <h3 style={{ marginTop: 0 }}>Re-score round</h3>
            <p style={{ color: "#444" }}>
              Re-score all IGC flights in this round? Manual entries are preserved. This may take
              several minutes.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1.25rem" }}>
              <button type="button" onClick={close} style={btnStyle("#333", "#e9ecef")}>
                Cancel
              </button>
              <button
                type="button"
                data-testid="rescore-confirm-yes"
                onClick={() => {
                  void onConfirm();
                }}
                style={btnStyle("#fff", "#0a3622")}
              >
                Re-score
              </button>
            </div>
          </div>
        </div>
      )}

      {busy && (
        <div style={overlayStyle} data-testid="rescore-loading-overlay">
          <div style={{ ...cardStyle, textAlign: "center" }}>
            <div
              aria-hidden
              style={{
                width: 32,
                height: 32,
                margin: "0 auto 0.75rem",
                border: "3px solid #dee2e6",
                borderTopColor: "#0a3622",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <p style={{ margin: 0, fontWeight: 600 }}>Re-scoring {igcCount} pilots…</p>
            <p style={{ margin: "0.5rem 0 0", color: "#888", fontSize: "0.8rem" }}>
              This may take several minutes. You can leave this page open.
            </p>
          </div>
        </div>
      )}

      {phase.kind === "success" && (
        <div style={overlayStyle}>
          <div style={cardStyle} role="dialog" aria-modal="true" data-testid="rescore-success-modal">
            <h3 style={{ marginTop: 0 }}>Re-score complete</h3>
            {phase.job.status === "partial" && (
              <p
                data-testid="rescore-partial-warning"
                style={{
                  background: "#fff3cd",
                  color: "#664d03",
                  padding: "0.5rem 0.75rem",
                  borderRadius: "0.3rem",
                  fontSize: "0.85rem",
                }}
              >
                Budget reached — re-run to finish the remaining{" "}
                {phase.job.counts?.skippedBudgetCount ?? 0} pilot(s).
              </p>
            )}
            <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "0.25rem 1rem", margin: 0 }}>
              <dt>Re-scored</dt>
              <dd data-testid="rescore-count-rescored" style={{ margin: 0, textAlign: "right", fontWeight: 700 }}>
                {phase.job.counts?.rescoredCount ?? 0}
              </dd>
              <dt>Skipped (manual)</dt>
              <dd data-testid="rescore-count-manual" style={{ margin: 0, textAlign: "right" }}>
                {phase.job.counts?.skippedManualCount ?? 0}
              </dd>
              <dt>Skipped (no IGC)</dt>
              <dd data-testid="rescore-count-no-igc" style={{ margin: 0, textAlign: "right" }}>
                {phase.job.counts?.skippedNoIgcCount ?? 0}
              </dd>
              <dt>Skipped (budget)</dt>
              <dd data-testid="rescore-count-budget" style={{ margin: 0, textAlign: "right" }}>
                {phase.job.counts?.skippedBudgetCount ?? 0}
              </dd>
            </dl>
            {phase.job.errors && phase.job.errors.length > 0 && (
              <div data-testid="rescore-errors" style={{ marginTop: "0.75rem" }}>
                <strong style={{ fontSize: "0.85rem", color: "#842029" }}>
                  Errors ({phase.job.errors.length})
                </strong>
                <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem", fontSize: "0.8rem", color: "#842029" }}>
                  {phase.job.errors.map((e, i) => (
                    <li key={`${e.teamId}:${e.place}:${i}`}>
                      Team {e.teamId}, place {e.place}: {e.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.25rem" }}>
              <button type="button" onClick={close} style={btnStyle("#fff", "#0a3622")}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {phase.kind === "timeout" && (
        <div style={overlayStyle}>
          <div style={cardStyle} role="dialog" aria-modal="true" data-testid="rescore-timeout-modal">
            <h3 style={{ marginTop: 0 }}>Still running</h3>
            <p style={{ color: "#444" }}>
              Re-scoring is taking longer than expected and is still running in the background.
              Check back on this round shortly to see the updated scores.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.25rem" }}>
              <button type="button" onClick={close} style={btnStyle("#333", "#e9ecef")}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {phase.kind === "error" && (
        <div style={overlayStyle}>
          <div style={cardStyle} role="dialog" aria-modal="true" data-testid="rescore-error-modal">
            <h3 style={{ marginTop: 0, color: "#842029" }}>Re-score failed</h3>
            <p style={{ color: "#444" }}>{phase.message}</p>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.25rem" }}>
              <button type="button" onClick={close} style={btnStyle("#333", "#e9ecef")}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
