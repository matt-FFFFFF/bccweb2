// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import PilotProfile from "../PilotProfile.js";
import { api, ApiError } from "../../../lib/api.js";
import { useBlob } from "../../../hooks/useBlob.js";
import { useAuth } from "../../../hooks/useAuth.js";
import type { Pilot, Manufacturer, ClubSummary } from "@bccweb/types";

vi.mock("../../../lib/api.js", async () => {
  const actual = await vi.importActual("../../../lib/api.js");
  return {
    ...actual,
    api: {
      get: vi.fn(),
      put: vi.fn(),
    },
  };
});

vi.mock("../../../hooks/useBlob.js", () => ({
  useBlob: vi.fn(),
}));

vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: vi.fn(),
}));

const mockPilot: Pilot = {
  id: "pilot-123",
  legacyId: null,
  coachType: "None",
  pilotRating: "Pilot",
  person: {
    id: "person-1",
    firstName: "Test",
    lastName: "Flyer",
    fullName: "Test Flyer",
  },
  seasonClubs: [],
  userId: null,
  wingManufacturer: {
    id: "mfr-ozone",
    name: "Ozone",
    websiteUrl: "https://flyozone.com",
  },
};

const mockManufacturers: Manufacturer[] = [
  { id: "mfr-ozone", name: "Ozone", websiteUrl: "https://flyozone.com" },
  { id: "mfr-gin", name: "Gin Gliders", websiteUrl: "https://gingliders.com" },
  { id: "mfr-noweb", name: "NoWebMfr" }, // no websiteUrl
];

const mockClubs: ClubSummary[] = [
  { id: "club-abc", name: "Test Club" },
  { id: "club-xyz", name: "Other Club" },
];

const flownResults = [
  {
    teamResults: [
      {
        pilots: [
          { pilotId: "pilot-123", pilotName: "Test Flyer", distance: 1, score: 1, wingClass: "EN B" },
        ],
      },
    ],
  },
];

const nullPilotResults = [
  {
    teamResults: [
      {
        pilots: [
          { pilotId: null, pilotName: "Ghost", distance: 1, score: 1, wingClass: "EN B" },
          { pilotId: "other-999", pilotName: "Someone Else", distance: 2, score: 2, wingClass: "EN C" },
        ],
      },
    ],
  },
];

const renderProfile = (pilotId = "pilot-123") =>
  render(
    <MemoryRouter initialEntries={[`/pilots/${pilotId}`]}>
      <Routes>
        <Route path="/pilots/:id" element={<PilotProfile />} />
      </Routes>
    </MemoryRouter>
  );

function getClubSelect(): HTMLSelectElement {
  const select = screen
    .getAllByRole("combobox")
    .find(
      (el): el is HTMLSelectElement =>
        el instanceof HTMLSelectElement &&
        Array.from(el.options).some((o) => o.text === "Test Club"),
    );
  if (!select) throw new Error("club select not found");
  return select;
}

describe("PilotProfile wing manufacturer dropdown", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "pilots/pilot-123") return mockPilot;
      if (path === "pilots/pilot-123/club-history") return [];
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.mocked(api.put).mockResolvedValue({});
    
    // Default auth mock: pilot editing self
    vi.mocked(useAuth).mockReturnValue({
      identity: {
        userId: "u1",
        email: "pilot@example.com",
        roles: ["Pilot"],
        pilotId: "pilot-123",
        clubId: null,
        activeSeasonYear: 2025,
      },
      loading: false,
      logout: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    // Default useBlob mock: clubs and manufacturers present
    vi.mocked(useBlob).mockImplementation((path: string | null) => {
      if (path === "clubs.json") return { data: mockClubs, loading: false, notFound: false, error: null };
      if (path === "manufacturers.json") return { data: mockManufacturers, loading: false, notFound: false, error: null };
      if (path === "results/2025.json") return { data: [], loading: false, notFound: false, error: null };
      return { data: null, loading: false, notFound: false, error: null };
    });
  });

  it("renders (none) + manufacturer options, choose + save sends full object", async () => {
    renderProfile();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Edit Profile" })).toBeInTheDocument();
    });

    const select = screen.getByLabelText("Wing manufacturer");
    const options = Array.from(select.querySelectorAll("option"));
    expect(options.map(o => o.text)).toEqual(["(none)", "Ozone", "Gin Gliders", "NoWebMfr"]);
    expect(select).toHaveValue("mfr-ozone");

    fireEvent.change(select, { target: { value: "mfr-gin" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(api.put).toHaveBeenCalledWith(
      "pilots/pilot-123",
      expect.objectContaining({
        wingManufacturer: { id: "mfr-gin", name: "Gin Gliders", websiteUrl: "https://gingliders.com" },
      })
    );
  });

  it("manufacturer WITHOUT websiteUrl omits websiteUrl in submitted object", async () => {
    renderProfile();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Edit Profile" })).toBeInTheDocument();
    });

    const select = screen.getByLabelText("Wing manufacturer");
    fireEvent.change(select, { target: { value: "mfr-noweb" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(api.put).toHaveBeenCalledWith(
      "pilots/pilot-123",
      expect.objectContaining({
        wingManufacturer: { id: "mfr-noweb", name: "NoWebMfr" },
      })
    );

    // ensure websiteUrl is absolutely not in the object (not undefined, but omitted)
    const callArgs = vi.mocked(api.put).mock.calls[0][1] as Record<string, unknown>;
    expect("websiteUrl" in (callArgs.wingManufacturer as Record<string, unknown>)).toBe(false);
  });

  it("renders for BOTH admin and self (isAdmin true AND false)", async () => {
    // Test 1: Admin editing pilot
    vi.mocked(useAuth).mockReturnValue({
      identity: {
        userId: "uAdmin",
        email: "admin@example.com",
        roles: ["Admin"],
        pilotId: null,
        clubId: null,
      },
      loading: false,
      logout: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    const { unmount } = renderProfile();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Edit Profile" })).toBeInTheDocument();
    });
    
    let select = screen.getByLabelText("Wing manufacturer");
    expect(select).toBeInTheDocument();
    
    unmount();
    
    // Test 2: Self (Pilot) editing self (already tested implicitly in others, but we check explicitly)
    vi.mocked(useAuth).mockReturnValue({
      identity: {
        userId: "uPilot",
        email: "pilot@example.com",
        roles: ["Pilot"],
        pilotId: "pilot-123",
        clubId: null,
      },
      loading: false,
      logout: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    
    renderProfile();
    
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Edit Profile" })).toBeInTheDocument();
    });
    
    select = screen.getByLabelText("Wing manufacturer");
    expect(select).toBeInTheDocument();
  });

  it("missing blob - useBlob->{data:null,notFound:true} -> select still renders fallback, form usable", async () => {
    vi.mocked(useBlob).mockImplementation((path: string | null) => {
      if (path === "clubs.json") return { data: [], loading: false, notFound: false, error: null };
      if (path === "manufacturers.json") return { data: null, loading: false, notFound: true, error: null };
      return { data: null, loading: false, notFound: false, error: null };
    });

    renderProfile();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Edit Profile" })).toBeInTheDocument();
    });

    const select = screen.getByLabelText("Wing manufacturer");
    // Should render "(none)" + the fallback "Ozone" because the pilot's current isn't in `manufacturers` (which is null)
    const options = Array.from(select.querySelectorAll("option"));
    expect(options.map(o => o.text)).toEqual(["(none)", "Ozone"]);
    
    // submitting should work and because "mfr-ozone" is selected but manufacturers is null, find() returns undefined, meaning form keeps existing
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    
    // wait for success message
    await waitFor(() => {
      expect(screen.getByText("Saved.")).toBeInTheDocument();
    });
  });

  it("(none) selected -> wingManufacturer is undefined in payload", async () => {
    renderProfile();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Edit Profile" })).toBeInTheDocument();
    });

    const select = screen.getByLabelText("Wing manufacturer");
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const callArgs = vi.mocked(api.put).mock.calls[0][1] as Record<string, unknown>;
    expect("wingManufacturer" in callArgs).toBe(true);
    expect(callArgs.wingManufacturer).toBeUndefined();
  });

  it("not flown (self): club select enabled; changing club + save sends currentClub", async () => {
    renderProfile();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Edit Profile" })).toBeInTheDocument();
    });

    const clubSelect = getClubSelect();
    expect(clubSelect).not.toBeDisabled();

    fireEvent.change(clubSelect, { target: { value: "club-abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(api.put).toHaveBeenCalledWith(
      "pilots/pilot-123",
      expect.objectContaining({ currentClub: { id: "club-abc", name: "Test Club" } }),
    );
  });

  it("flown (self): club select disabled, locked note shown, save omits currentClub", async () => {
    vi.mocked(useBlob).mockImplementation((path: string | null) => {
      if (path === "clubs.json") return { data: mockClubs, loading: false, notFound: false, error: null };
      if (path === "manufacturers.json") return { data: mockManufacturers, loading: false, notFound: false, error: null };
      if (path === "results/2025.json") return { data: flownResults, loading: false, notFound: false, error: null };
      return { data: null, loading: false, notFound: false, error: null };
    });

    renderProfile();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Edit Profile" })).toBeInTheDocument();
    });

    const clubSelect = getClubSelect();
    expect(clubSelect).toBeDisabled();
    expect(screen.getByText(/flown a scored round/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Wing manufacturer"), { target: { value: "mfr-gin" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const callArgs = vi.mocked(api.put).mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.currentClub).toBeUndefined();
    expect(callArgs.wingManufacturer).toEqual({
      id: "mfr-gin",
      name: "Gin Gliders",
      websiteUrl: "https://gingliders.com",
    });
  });

  it("null pilotId result row does not lock the club and does not throw", async () => {
    vi.mocked(useBlob).mockImplementation((path: string | null) => {
      if (path === "clubs.json") return { data: mockClubs, loading: false, notFound: false, error: null };
      if (path === "manufacturers.json") return { data: mockManufacturers, loading: false, notFound: false, error: null };
      if (path === "results/2025.json") return { data: nullPilotResults, loading: false, notFound: false, error: null };
      return { data: null, loading: false, notFound: false, error: null };
    });

    renderProfile();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Edit Profile" })).toBeInTheDocument();
    });

    expect(getClubSelect()).not.toBeDisabled();
    expect(screen.queryByText(/flown a scored round/i)).toBeNull();
  });

  it("admin: club select enabled even when the pilot has flown", async () => {
    vi.mocked(useAuth).mockReturnValue({
      identity: {
        userId: "uAdmin",
        email: "admin@example.com",
        roles: ["Admin"],
        pilotId: null,
        clubId: null,
        activeSeasonYear: 2025,
      },
      loading: false,
      logout: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    vi.mocked(useBlob).mockImplementation((path: string | null) => {
      if (path === "clubs.json") return { data: mockClubs, loading: false, notFound: false, error: null };
      if (path === "manufacturers.json") return { data: mockManufacturers, loading: false, notFound: false, error: null };
      if (path === "results/2025.json") return { data: flownResults, loading: false, notFound: false, error: null };
      return { data: null, loading: false, notFound: false, error: null };
    });

    renderProfile();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Edit Profile" })).toBeInTheDocument();
    });

    expect(getClubSelect()).not.toBeDisabled();
    expect(screen.queryByText(/flown a scored round/i)).toBeNull();
  });

  it("409 CLUB_LOCKED on save shows a clear banner and re-fetches the pilot", async () => {
    vi.mocked(api.put).mockRejectedValue(new ApiError(409, "CLUB_LOCKED", "locked"));

    renderProfile();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Edit Profile" })).toBeInTheDocument();
    });

    const getsBefore = vi.mocked(api.get).mock.calls.filter((c) => c[0] === "pilots/pilot-123").length;

    fireEvent.change(getClubSelect(), { target: { value: "club-abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(screen.getByText(/locked for this season/i)).toBeInTheDocument();
    });

    await waitFor(() => {
      const getsAfter = vi.mocked(api.get).mock.calls.filter((c) => c[0] === "pilots/pilot-123").length;
      expect(getsAfter).toBeGreaterThan(getsBefore);
    });
  });
});
