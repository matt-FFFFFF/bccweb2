// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import "../../../__tests__/setup.ts";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallerIdentity, Round } from "@bccweb/types";
import { makeRound, makeIdentity, renderPage } from "./RoundManage.captains.helpers.js";

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
  useBlob: (path: string | null) => {
    if (path === "pilots.json") return { data: [], loading: false, error: null, notFound: false };
    if (path === "clubs.json") return {
      data: [{ id: "club-org", name: "Org Club" }, { id: "club-visit", name: "Visit Club" }],
      loading: false, error: null, notFound: false
    };
    if (path === "club-teams.json") return {
      data: [
        { id: "team1", clubId: "club-org", seasonYear: 2026, teamName: "Org A" },
        { id: "team2", clubId: "club-org", seasonYear: 2026, teamName: "Org B" },
        { id: "team3", clubId: "club-visit", seasonYear: 2026, teamName: "Visit A" },
        { id: "team4", clubId: "club-visit", seasonYear: 2026, teamName: "Visit B" },
      ],
      loading: false, error: null, notFound: false
    };
    return { data: null, loading: false, error: null, notFound: true };
  }
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

describe("RoundManage teams permissions", () => {
  beforeEach(() => {
    state.round = makeRound();
    state.identity = makeIdentity({ roles: ["RoundsCoord"], clubId: "club-visit" });
    state.apiGet.mockReset().mockImplementation(async () => state.round);
    state.apiPost.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  it("visiting coordinator can only add teams for their own club", async () => {
    renderPage();

    await screen.findByRole("button", { name: "Add Team" });

    const addTeamForm = screen.getByRole("button", { name: "Add Team" }).closest("form")!;

    // There should NOT be a club selector at all!
    const clubSelect = within(addTeamForm).queryByRole("combobox", { name: /club/i });
    // And actually there is NO label 'Club' or an option '— club —'
    const hasClubOption = within(addTeamForm).queryByRole("option", { name: "— club —" });
    expect(hasClubOption).toBeNull();

    // The team selector SHOULD be there, and SHOULD be populated with Visit Club teams
    // Visit A is already added in the mock, so Visit B should be available.
    const teamSelects = within(addTeamForm).getAllByRole("combobox");
    expect(teamSelects.length).toBe(1);

    const options = within(teamSelects[0]).getAllByRole("option");
    expect(options.length).toBe(2);
    expect(options[0]).toHaveTextContent("— team —");
    expect(options[1]).toHaveTextContent("Visit B");
  });

  it("Admin can add teams for any club", async () => {
    state.identity = makeIdentity({ roles: ["Admin"] });
    renderPage();

    await screen.findByRole("button", { name: "Add Team" });

    const addTeamForm = screen.getByRole("button", { name: "Add Team" }).closest("form")!;

    // Admin sees the club selector
    const hasClubOption = within(addTeamForm).queryByRole("option", { name: "— club —" });
    expect(hasClubOption).not.toBeNull();

    const selects = within(addTeamForm).getAllByRole("combobox");
    expect(selects.length).toBe(2); // Club, and Team

    const clubOptions = within(selects[0]).getAllByRole("option");
    expect(clubOptions.length).toBe(3); // null, org, visit
  });
});
