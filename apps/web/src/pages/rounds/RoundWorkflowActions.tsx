// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { RoundStatus } from "@bccweb/types";
import { api } from "../../lib/api.js";
import { btnStyle, sectionStyle, WORKFLOW } from "./RoundManage.shared.js";
import { Banner } from "../../components/Banner.js";

export function RoundWorkflowActions({
  roundId,
  status,
  canManage,
  canOverrideSign,
  actionBusy,
  actionErr,
  confirmModal,
  setActionErr,
  setActionBusy,
  setConfirmModal,
  runAction,
}: {
  roundId: string;
  status: RoundStatus;
  canManage: boolean;
  canOverrideSign: boolean;
  actionBusy: string | null;
  actionErr: string | null;
  confirmModal: { label: string; endpoint: string; count: number } | null;
  setActionErr: (err: string | null) => void;
  setActionBusy: (busy: string | null) => void;
  setConfirmModal: (modal: { label: string; endpoint: string; count: number } | null) => void;
  runAction: (label: string, fn: () => Promise<unknown>) => void;
}) {
  const workflowActions = WORKFLOW[status] ?? [];
  const canRecreatePt = status === "Locked" || status === "Complete";
  const hasActions = workflowActions.length > 0 || canRecreatePt || canOverrideSign;

  if (!canManage || !hasActions) return null;

  return (
    <div style={{ ...sectionStyle, display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
      <strong style={{ fontSize: "0.85rem", color: "#555" }}>Actions:</strong>
      {workflowActions.map((a) => (
        <button
          key={a.endpoint}
          disabled={actionBusy !== null}
          style={btnStyle(a.color, a.bg)}
          onClick={() => {
            if (a.requiresConfirm) {
              setActionErr(null);
              setActionBusy(a.label);
              api.post<{ invalidatedSignatureCount: number }>(`rounds/${roundId}/${a.endpoint}?dryRun=true`)
                .then(res => setConfirmModal({ label: a.label, endpoint: a.endpoint, count: res.invalidatedSignatureCount || 0 }))
                .catch(ex => setActionErr(ex instanceof Error ? ex.message : "Dry run failed"))
                .finally(() => setActionBusy(null));
            } else {
              void runAction(a.label, () => api.post(`rounds/${roundId}/${a.endpoint}`));
            }
          }}
        >
          {actionBusy === a.label ? "Working…" : a.label}
        </button>
      ))}
      {canOverrideSign && (
        <button
          disabled={actionBusy !== null}
          style={btnStyle("#58151c", "#f8d7da")}
          onClick={() => void runAction("Re-sync Sign-to-Fly", () => api.post(`rounds/${roundId}/reflect-sign-to-fly`))}
        >
          {actionBusy === "Re-sync Sign-to-Fly" ? "Working…" : "Re-sync Sign-to-Fly"}
        </button>
      )}
      {canRecreatePt && (
        <button
          disabled={actionBusy !== null}
          style={btnStyle("#0f5132", "#d1e7dd")}
          onClick={() => void runAction("Recreate PureTrack Groups", () => api.post(`rounds/${roundId}/puretrack/create-groups`))}
        >
          {actionBusy === "Recreate PureTrack Groups" ? "Working…" : "Recreate PureTrack Groups"}
        </button>
      )}
      {actionErr && <Banner msg={actionErr} />}
      {confirmModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="round-workflow-confirm-title"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}
        >
          <div style={{ background: "#fff", padding: "1.5rem", borderRadius: "0.5rem", maxWidth: "400px", width: "100%" }}>
            <h3 id="round-workflow-confirm-title" style={{ marginTop: 0 }}>Confirm {confirmModal.label}</h3>
            <p>This will reset <strong>{confirmModal.count}</strong> pilot signature(s) (their 'Sign To Fly' flags will be reset).</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1.5rem" }}>
              <button onClick={() => setConfirmModal(null)} style={btnStyle("#333", "#e9ecef")}>Cancel</button>
              <button
                onClick={() => {
                  const { label, endpoint } = confirmModal;
                  setConfirmModal(null);
                  void runAction(label, () => api.post(`rounds/${roundId}/${endpoint}`));
                }}
                style={btnStyle("#fff", "#dc3545")}
              >
                Confirm & {confirmModal.label.includes("Reopen") ? "Reopen" : "Proceed"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
