import "../../../__tests__/setup.ts";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pilot } from "@bccweb/types";
import PilotProfile from "../PilotProfile.js";

const state = vi.hoisted(() => ({
  pilot: null as Pilot | null,
}));

vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: () => ({
    loading: false,
    identity: { userId: "user-1", email: "pilot@example.com", roles: ["Pilot"], pilotId: "pilot-1", clubId: null },
    isRefreshing: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock("../../../lib/api.js", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    get: vi.fn(async () => state.pilot),
  },
}));

describe("PilotProfile manufacturer link", () => {
  afterEach(() => {
    state.pilot = null;
    vi.restoreAllMocks();
  });

  it("wing manufacturer with websiteUrl renders as anchor", async () => {
    state.pilot = makePilot({ wingManufacturer: { id: "mfr-1", name: "Advance", websiteUrl: "https://advance.example" }, wingModel: "Alpha" });

    renderPage();

    const link = await screen.findByRole("link", { name: "Advance Alpha" });
    expect(link).toHaveAttribute("href", "https://advance.example/");
  });

  it("wing manufacturer without websiteUrl renders plain text", async () => {
    state.pilot = makePilot({ wingManufacturer: { id: "mfr-2", name: "Ozone" }, wingModel: "Delta" });

    renderPage();

    await waitFor(() => expect(screen.getByText("Ozone Delta")).toBeVisible());
    expect(screen.queryByRole("link", { name: "Ozone Delta" })).not.toBeInTheDocument();
  });
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={[
      "/pilots/pilot-1",
    ]}>
      <Routes>
        <Route path="/pilots/:id" element={<PilotProfile />} />
      </Routes>
    </MemoryRouter>,
  );
}

function makePilot(overrides: Partial<Pilot> = {}): Pilot {
  return {
    id: "pilot-1",
    legacyId: null,
    coachType: "None",
    pilotRating: "Pilot",
    person: { id: "person-1", firstName: "Pat", lastName: "Pilot", fullName: "Pat Pilot" },
    seasonClubs: [],
    userId: null,
    ...overrides,
  };
}
