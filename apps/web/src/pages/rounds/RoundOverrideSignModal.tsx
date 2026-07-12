// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import type { PilotSummary, Team, PilotSlot, Signature } from "@bccweb/types";
import { api, ApiError } from "../../lib/api.js";
import { btnStyle, inputStyle, pilotDisplayName } from "./RoundManage.shared.js";
import { Banner } from "../../components/Banner.js";

export function OverrideSignModal({
  roundId,
  team,
  slot,
  pilots,
  onClose,
  onSuccess
}: {
  roundId: string;
  team: Team;
  slot: PilotSlot;
  pilots: PilotSummary[] | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideErr, setOverrideErr] = useState<string | null>(null);
  const [overrideBusy, setOverrideBusy] = useState(false);

  async function submitOverride(e: React.FormEvent) {
    e.preventDefault();
    if (!slot.pilotId || overrideReason.trim().length < 20) return;
    setOverrideBusy(true);
    setOverrideErr(null);
    try {
      await api.post<Signature>(
        `rounds/${roundId}/teams/${team.id}/pilots/${slot.placeInTeam}/sign-override`,
        { reason: overrideReason, onBehalfOfPilotId: slot.pilotId }
      );
      onSuccess();
    } catch (ex) {
      if (ex instanceof ApiError && ex.code === "INVALID_REASON") {
        setOverrideErr(ex.detail ?? ex.message);
      } else {
        setOverrideErr(ex instanceof Error ? ex.message : "Failed to record override signature");
      }
    } finally {
      setOverrideBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`override-title-${team.id}-${slot.placeInTeam}`}
      style={{
        marginTop: "0.75rem",
        padding: "0.85rem",
        border: "1px solid #f0c36d",
        borderRadius: "0.5rem",
        background: "#fffaf0",
      }}
    >
      <h3 id={`override-title-${team.id}-${slot.placeInTeam}`} style={{ margin: "0 0 0.5rem", fontSize: "1rem" }}>
        Override Sign: {pilotDisplayName(slot.pilotId, pilots)}
      </h3>
      <p style={{ margin: "0 0 0.5rem", color: "#664d03", fontSize: "0.85rem" }}>
        {team.teamName}, place {slot.placeInTeam}. This will record a coord-override signature on the immutable ledger. The pilot's own sign-to-fly remains preferred; this is for documented exceptions only.
      </p>
      <form onSubmit={(e) => { void submitOverride(e); }}>
        <label htmlFor={`override-reason-${team.id}-${slot.placeInTeam}`} style={{ display: "block", fontSize: "0.8rem", color: "#555", marginBottom: "0.25rem" }}>
          Reason (minimum 20 characters)
        </label>
        <textarea
          id={`override-reason-${team.id}-${slot.placeInTeam}`}
          required
          minLength={20}
          rows={4}
          style={{ ...inputStyle, width: "100%", resize: "vertical" }}
          value={overrideReason}
          onChange={(e) => setOverrideReason(e.target.value)}
        />
        {overrideErr && <Banner msg={overrideErr} />}
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <button
            type="submit"
            disabled={overrideBusy || overrideReason.trim().length < 20}
            style={btnStyle("#fff", overrideBusy || overrideReason.trim().length < 20 ? "#6c757d" : "#8a5a00")}
          >
            {overrideBusy ? "Recording…" : "Submit Override"}
          </button>
          <button
            type="button"
            disabled={overrideBusy}
            style={btnStyle("#333", "#e9ecef")}
            onClick={() => onClose()}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
