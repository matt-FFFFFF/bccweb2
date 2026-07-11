// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import "../../../__tests__/setup.ts";
import { cleanup, render, screen, within } from "@testing-library/react";
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

vi.mock("../../../components/MarkdownEditor.js", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string, onChange: (val: string) => void }) => <textarea value={value} onChange={e => onChange(e.target.value)} />
}));
vi.mock("../../../components/MarkdownView.js", () => ({
  MarkdownView: ({ markdown }: { markdown: string }) => <div>{markdown}</div>
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
      ? [
          { id: "pilot-1", name: "Pat Pilot", rating: "Pilot", clubId: "club-org" },
          { id: "pilot-2", name: "Vic Visitor", rating: "Pilot", clubId: "club-visit" },
        ]
      : [{ id: "club-org", name: "Org Club" }, { id: "club-visit", name: "Visit Club" }],
    loading: false,
    error: null,
    notFound: false,
  }),
}));

vi.mock("../../../lib/api.js", () => ({
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, message: string) {
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

describe("RoundManage captain permissions", () => {
  beforeEach(() => {
    state.round = makeRound();
    state.identity = makeIdentity({ roles: ["RoundsCoord"], clubId: "club-visit" });
    state.apiGet.mockReset().mockImplementation(async () => state.round);
    state.apiPost.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  it("visiting coordinator sees captain selector ONLY for their own teams", async () => {
    renderPage();
    
    // Visit A team matches visiting coord's clubId (club-visit) -> should show select
    // Org A team does NOT match -> should show read-only
    await screen.findByText("Org A");

    const visitTeamHeader = screen.getByText("Visit A").parentElement!;
    // Look specifically for the option "— none —" which belongs to the captain dropdown
    expect(within(visitTeamHeader).queryByRole("option", { name: "— none —" })).toBeInTheDocument();
    
    const orgTeamHeader = screen.getByText("Org A").parentElement!;
    // The option should not exist in the foreign team's header
    expect(within(orgTeamHeader).queryByRole("option", { name: "— none —" })).not.toBeInTheDocument();
    // But the label should
    expect(within(orgTeamHeader).getByText(/Captain:/)).toBeInTheDocument();
  });

  it("visiting coordinator does NOT gain workflow controls or sign overrides", async () => {
    state.round = makeRound({ status: "BriefComplete" }); // would show override if allowed
    renderPage();
    
    await screen.findByText("Org A");
    
    // No workflow buttons
    expect(screen.queryByRole("button", { name: "Lock Round" })).not.toBeInTheDocument();
    
    // No override sign
    expect(screen.queryByRole("button", { name: "Override Sign" })).not.toBeInTheDocument();
  });

  it("Admin sees editable team controls for all teams", async () => {
    state.identity = makeIdentity({ roles: ["Admin"] });
    renderPage();
    
    await screen.findByText("Org A");
    
    const visitTeamHeader = screen.getByText("Visit A").parentElement!;
    expect(within(visitTeamHeader).queryByRole("option", { name: "— none —" })).toBeInTheDocument();
    
    const orgTeamHeader = screen.getByText("Org A").parentElement!;
    expect(within(orgTeamHeader).queryByRole("option", { name: "— none —" })).toBeInTheDocument();
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
    clubId: "club-org",
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
    organisingClub: { id: "club-org", name: "Org Club" },
    season: { year: 2026 },
    teams: [
      {
        id: "team-org",
        teamName: "Org A",
        club: { id: "club-org", name: "Org Club" },
        score: 0,
        captainPilotId: null,
        pilots: [
          {
            placeInTeam: 1,
            pilotId: "pilot-1",
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            snapshot: null,
            flight: null,
          },
        ],
      },
      {
        id: "team-visit",
        teamName: "Visit A",
        club: { id: "club-visit", name: "Visit Club" },
        score: 0,
        captainPilotId: null,
        pilots: [
          {
            placeInTeam: 1,
            pilotId: "pilot-2",
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            snapshot: null,
            flight: null,
          },
        ],
      }
    ],
    ...overrides,
  };
}
