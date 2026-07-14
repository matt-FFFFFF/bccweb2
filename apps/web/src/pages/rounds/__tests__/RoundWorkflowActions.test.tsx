// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RoundWorkflowActions } from "../RoundWorkflowActions.js";

vi.mock("../../../lib/api.js", () => ({
  api: {
    post: vi.fn(),
  },
}));

describe("RoundWorkflowActions", () => {
  it("shows 'Recreate PureTrack Groups' when round is Locked and user can manage", () => {
    const runAction = vi.fn();
    const recreatePureTrack = vi.fn();
    const setActionErr = vi.fn();
    const setActionBusy = vi.fn();
    const setConfirmModal = vi.fn();

    // Render a Locked round with canManage=true
    render(
      <RoundWorkflowActions
        roundId="test-123"
        status="Locked"
        canManage={true}
        canOverrideSign={false}
        actionBusy={null}
        actionErr={null}
        confirmModal={null}
        setActionErr={setActionErr}
        setActionBusy={setActionBusy}
        setConfirmModal={setConfirmModal}
        runAction={runAction}
        recreatePureTrack={recreatePureTrack}
      />
    );

    const recreateBtn = screen.getByRole("button", { name: "Recreate PureTrack Groups" });

    // The button is enabled (no action in progress)
    expect(recreateBtn).not.toBeDisabled();

    fireEvent.click(recreateBtn);
    expect(recreatePureTrack).toHaveBeenCalledOnce();
  });

  it("disables 'Recreate PureTrack Groups' when actionBusy is set", () => {
    const runAction = vi.fn();
    const recreatePureTrack = vi.fn();
    const setActionErr = vi.fn();
    const setActionBusy = vi.fn();
    const setConfirmModal = vi.fn();

    render(
      <RoundWorkflowActions
        roundId="test-123"
        status="Locked"
        canManage={true}
        canOverrideSign={false}
        actionBusy="Recreate PureTrack Groups"
        actionErr={null}
        confirmModal={null}
        setActionErr={setActionErr}
        setActionBusy={setActionBusy}
        setConfirmModal={setConfirmModal}
        runAction={runAction}
        recreatePureTrack={recreatePureTrack}
      />
    );

    const recreateBtn = screen.getByRole("button", { name: "Working…" });

    expect(recreateBtn).toBeDisabled();
  });
});
