import "../../../__tests__/setup.ts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RoundBriefEdit from "../RoundBriefEdit.js";
import { ApiError } from "../../../lib/api.js";

const state = vi.hoisted(() => ({
  role: "Admin" as string | undefined,
  apiGet: vi.fn(),
  apiPut: vi.fn(),
}));

vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: () => ({
    identity: { roles: [state.role], clubId: "club-1" },
    
    
  }),
}));

vi.mock("../../../lib/api.js", () => ({
  api: {
    get: (...args: any[]) => state.apiGet(...args),
    put: (...args: any[]) => state.apiPut(...args),
    post: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  }
}));

describe("RoundBriefEdit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.role = "Admin";
    state.apiGet.mockResolvedValue({
      roundId: "round-1",
      briefingTime: "09:00",
      NOTAMs: "None",
      version: 1
    });
    state.apiPut.mockResolvedValue({
      brief: {},
      materialChanged: false,
      invalidatedSignatureCount: 0
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderComponent() {
    return render(
      <MemoryRouter initialEntries={["/rounds/round-1/brief/edit"]}>
        <Routes>
          <Route path="/rounds/:id/brief/edit" element={<RoundBriefEdit />} />
          <Route path="/rounds/:id/brief" element={<div data-testid="brief-view" />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it("renders form prefilled with current brief", async () => {
    renderComponent();
    await screen.findByText("Edit Round Brief");
    
    const input = await screen.findByDisplayValue("09:00");
    expect(input).toBeInTheDocument();
  });

  it("submit triggers confirm modal when server returns materialChanged true", async () => {
    state.apiPut.mockResolvedValue({
      brief: {},
      materialChanged: true,
      invalidatedSignatureCount: 3
    });

    renderComponent();
    await screen.findByText("Edit Round Brief");

    const saveBtn = screen.getByRole("button", { name: "Save Brief" });
    fireEvent.click(saveBtn);

    // Should call API with dryRun=true
    await waitFor(() => {
      expect(state.apiPut).toHaveBeenCalledWith("rounds/round-1/brief?dryRun=true", expect.anything());
    });

    // Should show modal
    const modalText = await screen.findByText(/Material Change Detected/i);
    expect(modalText).toBeInTheDocument();
    
    expect(screen.getByText("3")).toBeInTheDocument();

    // Confirm click should call API with dryRun=false
    const confirmBtn = screen.getByRole("button", { name: "Confirm & Invalidate" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(state.apiPut).toHaveBeenCalledWith("rounds/round-1/brief?dryRun=false", expect.anything());
    });
    
    // Navigates
    await screen.findByTestId("brief-view");
  });

  it("BRIEF_LOCKED error surfaces", async () => {
    state.apiPut.mockRejectedValue(new (await import("../../../lib/api.js")).ApiError(409, "BRIEF_LOCKED", "Locked"));

    renderComponent();
    await screen.findByText("Edit Round Brief");

    const saveBtn = screen.getByRole("button", { name: "Save Brief" });
    fireEvent.click(saveBtn);

    const error = await screen.findByText("Round is locked; unlock first to edit the brief.");
    expect(error).toBeInTheDocument();
  });

  it("cosmetic submit saves immediately", async () => {
    state.apiPut.mockResolvedValue({
      brief: {},
      materialChanged: false,
      invalidatedSignatureCount: 0
    });

    renderComponent();
    await screen.findByText("Edit Round Brief");

    const saveBtn = screen.getByRole("button", { name: "Save Brief" });
    fireEvent.click(saveBtn);

    // Call 1: dryRun=true -> returns materialChanged: false
    // Call 2: dryRun=false
    await waitFor(() => {
      expect(state.apiPut).toHaveBeenCalledTimes(2);
      expect(state.apiPut.mock.calls[0][0]).toBe("rounds/round-1/brief?dryRun=true");
      expect(state.apiPut.mock.calls[1][0]).toBe("rounds/round-1/brief?dryRun=false");
    });

    await screen.findByTestId("brief-view");
  });
});
