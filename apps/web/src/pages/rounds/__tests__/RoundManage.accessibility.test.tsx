// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import "../../../__tests__/setup.ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallerIdentity, Round } from "@bccweb/types";
import { makeIdentity, makeRound, renderPage } from "./RoundManage.captains.helpers.js";

const state = vi.hoisted(() => ({
  identity: null as CallerIdentity | null,
  round: null as Round | null,
  pilots: [] as Array<{ id: string; name: string; clubId?: string }>,
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock("../../../components/MarkdownEditor.js", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("../../../components/MarkdownView.js", () => ({
  MarkdownView: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}));
vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: () => ({ loading: false, identity: state.identity, isRefreshing: false }),
}));
vi.mock("../../../hooks/useBlob.js", () => ({
  useBlob: (path: string | null) => ({
    data: path === "pilots.json"
      ? state.pilots
      : path === "club-teams.json"
        ? [
            { id: "org-a", clubId: "club-org", clubName: "Org Club", seasonYear: 2026, teamName: "Org A" },
            { id: "org-b", clubId: "club-org", clubName: "Org Club", seasonYear: 2026, teamName: "Org B" },
          ]
        : [{ id: "club-org", name: "Org Club" }],
    loading: false,
    error: null,
    notFound: false,
  }),
}));
vi.mock("../../../lib/api.js", () => ({
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
  },
  api: { get: state.apiGet, post: state.apiPost, put: vi.fn(), delete: vi.fn() },
}));

describe("RoundManage accessibility", () => {
  beforeEach(() => {
    state.identity = makeIdentity({ roles: ["Admin"], clubId: "club-org" });
    state.round = makeRound({ teams: [makeRound().teams[0]] });
    state.pilots = [{ id: "pilot-1", name: "Match", clubId: "club-org" }];
    state.apiGet.mockReset().mockImplementation(async () => state.round);
    state.apiPost.mockReset().mockResolvedValue({});
  });
  afterEach(() => cleanup());

  it("names metadata, captain, add-team, and add-pilot fields", async () => {
    renderPage();
    await screen.findByText("Org A");
    expect(screen.getByRole("spinbutton", { name: "Max Teams" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Min Score" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Briefing Time")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "BHPA Level" })).toBeInTheDocument();
    expect(screen.getByLabelText("Images")).toHaveAttribute("type", "file");
    expect(screen.getByRole("combobox", { name: "Captain for Org A" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Club" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Team" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Add Pilot" }));
    expect(await screen.findByRole("combobox", { name: "Pilot for Org A" })).toBeInTheDocument();
  });

  it("exposes confirmation as a labelled modal dialog", async () => {
    state.apiPost.mockResolvedValueOnce({ invalidatedSignatureCount: 2 });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Mark Brief Complete" }));
    expect(await screen.findByRole("dialog", { name: "Confirm Mark Brief Complete" })).toBeInTheDocument();
  });

  it("filters the pilot selector by team club", async () => {
    state.pilots = [
      { id: "match", name: "Match", clubId: "club-org" },
      { id: "other", name: "Other", clubId: "club-other" },
      { id: "unknown", name: "Unknown" },
    ];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "+ Add Pilot" }));
    const picker = await screen.findByRole("combobox", { name: "Pilot for Org A" });
    expect(picker).toContainElement(screen.getByRole("option", { name: "Match" }));
    expect(picker).toContainElement(screen.getByRole("option", { name: "Unknown" }));
    expect(screen.queryByRole("option", { name: "Other" })).not.toBeInTheDocument();
  });

  it("names flight-entry controls", async () => {
    state.round = makeRound({ status: "Locked", isLocked: true });
    renderPage();
    const flightButtons = await screen.findAllByRole("button", { name: "+ Flight" });
    fireEvent.click(flightButtons[0]);
    expect(screen.getByRole("spinbutton", { name: "Distance (km) *" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Duration (min)" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Scoring type" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Flight URL" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "First XC" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "First UK XC" })).toBeInTheDocument();
  });

  it.each(["Proposed", "Confirmed"] as const)("offers Cancel Round at %s", async (status) => {
    state.round = makeRound({ status, teams: [] });
    renderPage();
    expect(await screen.findByRole("button", { name: "Cancel Round" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Uncancel" })).not.toBeInTheDocument();
  });

  it("makes a cancelled round read-only and offers Uncancel", async () => {
    state.round = makeRound({ status: "Cancelled" });
    renderPage();
    await screen.findByText("Org A");
    expect(screen.getByRole("button", { name: "Uncancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel Round" })).not.toBeInTheDocument();
    expect(screen.getByText(/No changes can be made/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Team" })).not.toBeInTheDocument();
  });
});
