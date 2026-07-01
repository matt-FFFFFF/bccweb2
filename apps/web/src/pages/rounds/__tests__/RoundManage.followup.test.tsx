import "../../../__tests__/setup.ts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallerIdentity, Round, RoundBrief, Team } from "@bccweb/types";
import RoundManage from "../RoundManage.js";

const state = vi.hoisted(() => ({
  identity: null as CallerIdentity | null,
  round: null as Round | null,
  brief: null as Partial<RoundBrief> | null,
  pilot: null as Record<string, unknown> | null,
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

vi.mock("../../../components/MarkdownEditor.js", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
    <textarea data-testid="markdown-editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock("../../../components/MarkdownView.js", () => ({
  MarkdownView: ({ markdown }: { markdown: string }) => <div data-testid="markdown-view">{markdown}</div>,
}));

vi.mock("../../../components/AuthImage.js", () => ({
  AuthImage: () => <img alt="brief" />,
}));

describe("RoundManage follow-up fixes", () => {
  beforeEach(() => {
    state.round = makeRound({ status: "Confirmed" });
    state.identity = makeIdentity({ roles: ["Admin"] });
    state.brief = { briefingTime: "09:00" };
    state.pilot = null;

    state.apiGet.mockReset().mockImplementation(async (path: string) => {
      if (path.startsWith("pilots/") && state.pilot) return state.pilot;
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
    state.apiDelete.mockReset().mockResolvedValue({});
  });

  afterEach(() => cleanup());

  // ─── Issue 1: briefer BHPA level dropdown + pre-fill from current context ─────

  it("BHPA Level is a dropdown with coach-level options", async () => {
    renderPage();
    const label = await screen.findByText("BHPA Level", { selector: "label" });
    const select = label.parentElement!.querySelector("select");
    expect(select).not.toBeNull();
    expect(screen.getByRole("option", { name: "Senior Coach" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Instructor" })).toBeInTheDocument();
  });

  it("pre-fills the briefer from the coordinator's own profile when empty", async () => {
    state.identity = makeIdentity({ roles: ["Admin"], pilotId: "pilot-me", email: "carl@bcc.test" });
    state.brief = {};
    state.pilot = {
      person: { fullName: "Coach Carl", phoneNumber: "07123456789" },
      coachType: "SeniorCoach",
      bhpaNumber: 4242,
    };

    renderPage();

    await screen.findByDisplayValue("Coach Carl");
    expect((await screen.findByDisplayValue("Coach Carl")).getAttribute("value")).toBe("Coach Carl");
    expect(screen.getByDisplayValue("07123456789")).toBeInTheDocument();
    expect(screen.getByDisplayValue("4242")).toBeInTheDocument();
    expect(screen.getByDisplayValue("carl@bcc.test")).toBeInTheDocument();
    expect((screen.getByDisplayValue("Senior Coach") as HTMLSelectElement).value).toBe("Senior Coach");
  });

  it("does NOT overwrite an existing briefer", async () => {
    state.identity = makeIdentity({ roles: ["Admin"], pilotId: "pilot-me", email: "carl@bcc.test" });
    state.brief = { briefer: { name: "Existing Briefer" } };
    state.pilot = { person: { fullName: "Coach Carl" }, coachType: "SeniorCoach" };

    renderPage();

    await screen.findByDisplayValue("Existing Briefer");
    expect(screen.queryByDisplayValue("Coach Carl")).not.toBeInTheDocument();
  });

  // ─── Issue 4: read-only markdown is greyed (opacity 0.6) when the brief is locked ─

  it("greys read-only markdown prose when the brief is disabled", async () => {
    state.round = makeRound({ status: "Locked", isLocked: true });
    state.brief = { briefersNotes: "**stay safe**" };

    renderPage();

    const views = await screen.findAllByTestId("markdown-view");
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) {
      expect((v.parentElement as HTMLElement).style.opacity).toBe("0.6");
    }
  });

  // ─── Issue 2: captain not changeable once Locked/Complete ─────────────────────

  it("shows the captain dropdown at Confirmed", async () => {
    state.round = makeRound({ status: "Confirmed", teams: [makeTeam()] });
    renderPage();
    await screen.findByRole("option", { name: "— none —" });
    expect(screen.getByRole("option", { name: "— none —" })).toBeInTheDocument();
  });

  it("hides the captain dropdown once Locked (read-only display)", async () => {
    state.round = makeRound({ status: "Locked", isLocked: true, teams: [makeTeam({ captainPilotId: "pilot-1" })] });
    renderPage();
    await screen.findByText("Alpha");
    expect(screen.queryByRole("option", { name: "— none —" })).not.toBeInTheDocument();
  });

  it("hides the captain dropdown once Complete", async () => {
    state.round = makeRound({ status: "Complete", isLocked: true, teams: [makeTeam({ captainPilotId: "pilot-1" })] });
    renderPage();
    await screen.findByText("Alpha");
    expect(screen.queryByRole("option", { name: "— none —" })).not.toBeInTheDocument();
  });

  // ─── Issue 3: no flight entry once Complete ───────────────────────────────────

  it("shows the + Flight button at Locked", async () => {
    state.round = makeRound({ status: "Locked", isLocked: true, teams: [makeTeam()] });
    renderPage();
    expect(await screen.findByRole("button", { name: "+ Flight" })).toBeInTheDocument();
  });

  it("hides all flight-entry buttons once Complete", async () => {
    state.round = makeRound({ status: "Complete", isLocked: true, teams: [makeTeam()] });
    renderPage();
    await screen.findByText("Alpha");
    expect(screen.queryByRole("button", { name: "+ Flight" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Flight" })).not.toBeInTheDocument();
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

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: "team-1",
    teamName: "Alpha",
    club: { id: "club-1", name: "Home Club" },
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
    ...overrides,
  };
}
