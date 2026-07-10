// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import PilotsList from "../PilotsList.js";
import { api } from "../../../lib/api.js";
import { useBlob } from "../../../hooks/useBlob.js";
import type { PilotSummary, ClubSummary } from "@bccweb/types";

vi.mock("../../../lib/api.js", async () => {
  const actual = await vi.importActual("../../../lib/api.js");
  return {
    ...actual,
    api: {
      get: vi.fn(),
    },
  };
});

vi.mock("../../../hooks/useBlob.js", () => ({
  useBlob: vi.fn(),
}));

describe("PilotsList clubName rendering", () => {
  const mockClubs: ClubSummary[] = [
    { id: "club-matched-uuid", name: "Glider Club Matched" }
  ];

  const mockPilots: PilotSummary[] = [
    { id: "p1", legacyId: null, name: "Pilot 1", clubId: "club-matched-uuid" },
    { id: "p2", legacyId: null, name: "Pilot 2", clubId: "club-nomatch-uuid" },
      { id: "p3", legacyId: null, name: "Pilot 3" },
  ];

  beforeEach(() => {
    vi.mocked(api.get).mockResolvedValue(mockPilots);

    vi.mocked(useBlob).mockImplementation((path) => {
      if (path === "clubs.json") {
        return { data: mockClubs, loading: false, error: null, notFound: false };
      }
      return { data: null, loading: false, error: null, notFound: false };
    });
  });

  it("renders club names or fallbacks depending on match", async () => {
    render(
      <MemoryRouter>
        <PilotsList />
      </MemoryRouter>
    );

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByText("Pilot 1")).toBeInTheDocument();
    });

    // 1. Matched club renders the NAME
    expect(screen.getByText("Glider Club Matched")).toBeInTheDocument();

    // 2. Unmatched club renders the raw UUID
    expect(screen.getByText("club-nomatch-uuid")).toBeInTheDocument();

    const rows = screen.getAllByRole("row");
    // rows[0] is header

    // rows[1] is Pilot 1
    expect(rows[1]).toHaveTextContent("Pilot 1");
    expect(rows[1]).toHaveTextContent("Glider Club Matched");

    // rows[2] is Pilot 2
    expect(rows[2]).toHaveTextContent("Pilot 2");
    expect(rows[2]).toHaveTextContent("club-nomatch-uuid");

    // rows[3] is Pilot 3
    expect(rows[3]).toHaveTextContent("Pilot 3");
    const cols = Array.from(rows[3].querySelectorAll("td")).map(td => td.textContent);
    expect(cols[1]).toBe("—");
  });
});
