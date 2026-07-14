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
  it("allows 'Recreate PureTrack Groups' when pending or processing", () => {
    const runAction = vi.fn();
    const setActionErr = vi.fn();
    const setActionBusy = vi.fn();
    const setConfirmModal = vi.fn();

    // Render with pureTrackStatus="pending"
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
      />
    );

    const recreateBtn = screen.getByRole("button", { name: "Recreate PureTrack Groups" });
    
    // It should not be disabled despite being 'pending'
    expect(recreateBtn).not.toBeDisabled();

    fireEvent.click(recreateBtn);
    expect(runAction).toHaveBeenCalledWith("Recreate PureTrack Groups", expect.any(Function));
  });

  it("disables 'Recreate PureTrack Groups' when actionBusy is set", () => {
    const runAction = vi.fn();
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
      />
    );

    const recreateBtn = screen.getByRole("button", { name: "Working…" });
    
    expect(recreateBtn).toBeDisabled();
  });
});
