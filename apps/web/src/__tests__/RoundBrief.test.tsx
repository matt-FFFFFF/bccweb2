// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import "./setup.ts";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { RoundBrief as RoundBriefType } from "@bccweb/types";
import RoundBrief from "../pages/rounds/RoundBrief.js";

vi.mock("../hooks/useAuth.js", () => ({
  useAuth: () => ({
    loading: false,
    identity: {
      userId: "user-1",
      email: "pilot@example.com",
      roles: ["Pilot"],
      pilotId: "pilot-1",
      clubId: null,
    },
    isRefreshing: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

function fullBrief(overrides: Partial<RoundBriefType> = {}): RoundBriefType {
  return {
    roundId: "round-1",
    generatedAt: "2026-06-09T09:00:00.000Z",
    date: "2026-06-09",
    siteName: "Milk Hill",
    windSpeedDirection: "12kt SW",
    directionOfFlight: "East",
    expectedLandingArea: "North field",
    airspaceAndHazards: "Avoid CTA",
    NOTAMs: "Temporary restriction",
    BENO_LineDescription: "Do not exceed ridge line",
    briefersNotes: "Watch sea breeze",
    briefer: {
      name: "Alex Briefer",
      bhpaCoachLevel: "SeniorCoach",
      bhpaNumber: "12345",
      phoneNumber: "07123 456789",
      emailAddress: "alex@example.com",
    },
    teams: [],
    ...overrides,
  };
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/rounds/round-1/brief"]}>
      <Routes>
        <Route path="/rounds/:id/brief" element={<RoundBrief />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("RoundBrief", () => {
  beforeEach(() => {
    localStorage.setItem("bcc_access_token", "test-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("renders safety briefing labels with full data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(fullBrief()), { status: 200 }));

    renderPage();

    expect(await screen.findByText("Safety Briefing")).toBeVisible();
    expect(screen.getByText("Wind Speed & Direction")).toBeVisible();
    expect(screen.getByText("Airspace & Hazards")).toBeVisible();
    expect(screen.getByText("Expected Landing Area")).toBeVisible();
    expect(screen.getByText("NOTAMs")).toBeVisible();
    expect(screen.getByText("BENO Line Description")).toBeVisible();
    expect(screen.getByText("Briefer's Notes")).toBeVisible();
    expect(screen.getByText("Alex Briefer")).toBeVisible();
  });

  it("renders Not provided for missing safety fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(fullBrief({
      windSpeedDirection: undefined,
      directionOfFlight: undefined,
      expectedLandingArea: undefined,
      airspaceAndHazards: undefined,
      NOTAMs: undefined,
      BENO_LineDescription: undefined,
      briefersNotes: undefined,
      briefer: undefined,
    })), { status: 200 }));

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("Not provided").length).toBeGreaterThan(0);
    });
  });
});
