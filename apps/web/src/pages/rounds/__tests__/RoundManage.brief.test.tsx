import "../../../__tests__/setup.ts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallerIdentity, Round, RoundBrief } from "@bccweb/types";
import RoundManage from "../RoundManage.js";

const state = vi.hoisted(() => ({
  identity: null as CallerIdentity | null,
  round: null as Round | null,
  brief: null as Partial<RoundBrief> | null,
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: () => ({
    loading: false,
    identity: state.identity,
    isRefreshing: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useBlob.js", () => ({
  useBlob: (path: string | null) => ({
    data: path === "pilots.json"
      ? [{ id: "pilot-1", name: "Pat Pilot", rating: "Pilot", clubId: "club-1" }]
      : [{ id: "club-1", name: "Home Club" }],
    loading: false,
    error: null,
    notFound: false,
  }),
}));

vi.mock("../../../lib/api.js", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly requestId?: string,
      public readonly detail?: string,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
  api: {
    get: state.apiGet,
    post: state.apiPost,
    put: state.apiPut,
    delete: state.apiDelete,
  },
}));

// Mock MarkdownEditor to be a simple textarea
vi.mock("../../../components/MarkdownEditor.js", () => ({
  MarkdownEditor: ({ value, onChange, placeholder }: { value: string, onChange: (val: string) => void, placeholder?: string }) => (
    <textarea
      data-testid="markdown-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  ),
}));

vi.mock("../../../components/MarkdownView.js", () => ({
  MarkdownView: ({ markdown }: { markdown: string }) => <div data-testid="markdown-view">{markdown}</div>,
}));

describe("RoundManage Brief Section", () => {
  beforeEach(() => {
    state.round = makeRound({ status: "Confirmed" });
    state.identity = makeIdentity({ roles: ["Admin"] });
    state.brief = {
      briefingTime: "09:00",
      takeOffW3W: "apples.oranges.bananas",
    };
    
    state.apiGet.mockReset().mockImplementation(async (path: string) => {
      if (path.endsWith("/brief")) {
        if (!state.brief) {
          throw new (await import("../../../lib/api.js")).ApiError(404, "NOT_FOUND", "No brief yet");
        }
        return state.brief;
      }
      return state.round;
    });
    state.apiPut.mockReset().mockResolvedValue({});
    state.apiPost.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  it("enabled at Confirmed, saving calls PUT .../brief", async () => {
    renderPage();
    
    await screen.findByDisplayValue("09:00");
    const input = await screen.findByDisplayValue("09:00");
    expect(input).not.toBeDisabled();
    
    fireEvent.change(input, { target: { value: "09:30" } });
    
    // Save button inside Brief section
    const saveBtn = screen.getByRole("button", { name: "Save Brief" });
    fireEvent.click(saveBtn);
    
    await waitFor(() => {
      expect(state.apiPut).toHaveBeenCalledWith(
        "rounds/round-1/brief",
        expect.objectContaining({ briefingTime: "09:30" })
      );
    });
  });

  it("MetadataForm no longer renders time inputs", async () => {
    renderPage();
    await screen.findByText("Max Teams"); // Wait for MetadataForm
    // They should exist ONLY once (in BriefForm, not in MetadataForm)
    expect(screen.getAllByText("Check-in By", { selector: "label" })).toHaveLength(1);
    expect(screen.getAllByText("Land By", { selector: "label" })).toHaveLength(1);
  });

  it("disabled at BriefComplete, Reopen modal with count", async () => {
    state.round = makeRound({ status: "BriefComplete" });
    state.apiPost.mockResolvedValue({ invalidatedSignatureCount: 3 });
    
    renderPage();
    
    await screen.findByDisplayValue("09:00");
    const input = await screen.findByDisplayValue("09:00");
    expect(input).toBeDisabled();
    
    const reopenBtn = screen.getByRole("button", { name: "Reopen Brief" });
    fireEvent.click(reopenBtn);
    
    await screen.findByText("Confirm Reopen Brief");
    expect(screen.getByText("3")).toBeInTheDocument();
    
    fireEvent.click(screen.getByRole("button", { name: "Confirm & Reopen" }));
    
    await waitFor(() => {
      expect(state.apiPost).toHaveBeenCalledWith("rounds/round-1/reopen");
    });
  });

  it("no NarrativeForm rendered", async () => {
    renderPage();
    await screen.findByDisplayValue("09:00");
    
    expect(screen.queryByText("Save Narrative")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("HTML narrative text…")).not.toBeInTheDocument();
  });
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/rounds/round-1/manage"]}>
      <Routes>
        <Route path="/rounds/:id/manage" element={<RoundManage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function makeIdentity(overrides: Partial<CallerIdentity> = {}): CallerIdentity {
  return {
    userId: "user-1",
    email: "user@example.com",
    roles: ["Admin"],
    pilotId: null,
    clubId: "club-1",
    ...overrides,
  };
}

function makeRound(overrides: Partial<Round> = {}): Round {
  return {
    id: "round-1",
    date: "2026-06-09",
    status: "Confirmed",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-1", name: "Milk Hill" },
    organisingClub: { id: "club-1", name: "Home Club" },
    season: { year: 2026 },
    teams: [],
    ...overrides,
  };
}