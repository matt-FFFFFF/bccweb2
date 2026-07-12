// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

vi.mock("../../../components/MarkdownEditor.js", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string, onChange: (val: string) => void }) => <textarea value={value} onChange={e => onChange(e.target.value)} />
}));
vi.mock("../../../components/MarkdownView.js", () => ({
  MarkdownView: ({ markdown }: { markdown: string }) => <div>{markdown}</div>
}));
import "../../../__tests__/setup.ts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallerIdentity, Round } from "@bccweb/types";
import RoundManage from "../RoundManage.js";

const state = vi.hoisted(() => ({
  identity: null as CallerIdentity | null,
  round: null as Round | null,
  apiGet: vi.fn(),
  apiPost: vi.fn(),
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
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

describe("RoundManage override sign", () => {
  beforeEach(() => {
    state.round = makeRound();
    state.identity = makeIdentity({ roles: ["Admin"] });
    state.apiGet.mockReset().mockImplementation(async () => state.round);
    state.apiPost.mockReset().mockResolvedValue({ id: "sig-1", source: "coord-override" });
  });

  afterEach(() => {
    cleanup();
  });

  it("admin sees Override Sign button per slot in BriefComplete round", async () => {
    renderPage();

    expect(await screen.findByRole("button", { name: "Override Sign" })).toBeVisible();
  });

  it("non-admin / non-coord does NOT see Override Sign button", async () => {
    state.identity = makeIdentity({ roles: ["RoundsCoord"], clubId: "other-club" });

    renderPage();

    await screen.findByText("Pat Pilot");
    expect(screen.queryByRole("button", { name: "Override Sign" })).not.toBeInTheDocument();
  });

  it("Submit disabled until reason >= 20 chars", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Override Sign" }));
    const dialog = screen.getByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Submit Override" });
    expect(submit).toBeDisabled();

    const reason = within(dialog).getByRole("textbox", { name: "Reason (minimum 20 characters)" });
    fireEvent.change(reason, { target: { value: "too short" } });
    expect(submit).toBeDisabled();

    fireEvent.change(reason, {
      target: { value: "Pilot signed the paper form" },
    });
    expect(submit).not.toBeDisabled();
  });

  it("Submit calls override endpoint with correct payload", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Override Sign" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "Pilot signed the paper form" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit Override" }));

    await waitFor(() => {
      expect(state.apiPost).toHaveBeenCalledWith(
        "rounds/round-1/teams/team-1/pilots/1/sign-override",
        { reason: "Pilot signed the paper form", onBehalfOfPilotId: "pilot-1" },
      );
    });
  });

  it("admin sees Re-sync Sign-to-Fly button and clicking it calls the endpoint and reloads", async () => {
    renderPage();

    const btn = await screen.findByRole("button", { name: "Re-sync Sign-to-Fly" });
    expect(btn).toBeVisible();

    const initialGets = state.apiGet.mock.calls.length;

    fireEvent.click(btn);

    await waitFor(() => {
      expect(state.apiPost).toHaveBeenCalledWith("rounds/round-1/reflect-sign-to-fly");
    });
    
    await waitFor(() => {
      expect(state.apiGet.mock.calls.length).toBeGreaterThan(initialGets);
    });
  });

  it("non-admin / non-coord does NOT see Re-sync Sign-to-Fly button", async () => {
    state.identity = makeIdentity({ roles: ["Pilot"], clubId: "club-1" });

    renderPage();

    expect(screen.queryByRole("button", { name: "Re-sync Sign-to-Fly" })).not.toBeInTheDocument();
  });

  it("locked round does NOT show Re-sync Sign-to-Fly button", async () => {
    state.round = makeRound({ status: "Locked" });
    state.apiGet.mockImplementation(async () => state.round);

    renderPage();

    await screen.findByText("Pat Pilot");
    expect(screen.queryByRole("button", { name: "Re-sync Sign-to-Fly" })).not.toBeInTheDocument();
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
    status: "BriefComplete",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-1", name: "Milk Hill" },
    organisingClub: { id: "club-1", name: "Home Club" },
    season: { year: 2026 },
    teams: [{
      id: "team-1",
      teamName: "Home A",
      club: { id: "club-1", name: "Home Club" },
      score: 0,
      pilots: [{
        placeInTeam: 1,
        isScoring: true,
        status: "Filled",
        accountedFor: false,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        pilotId: "pilot-1",
        snapshot: null,
        flight: null,
      }],
    }],
    ...overrides,
  };
}
