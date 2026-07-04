import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import PilotProfile from "../PilotProfile.js";
import { api } from "../../../lib/api.js";
import { useBlob } from "../../../hooks/useBlob.js";
import { useAuth } from "../../../hooks/useAuth.js";
import type { Pilot, Manufacturer } from "@bccweb/types";

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

const renderProfile = (pilotId = "pilot-123") =>
  render(
    <MemoryRouter initialEntries={[`/pilots/${pilotId}`]}>
      <Routes>
        <Route path="/pilots/:id" element={<PilotProfile />} />
      </Routes>
    </MemoryRouter>
  );

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
      },
      loading: false,
      logout: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    // Default useBlob mock: clubs and manufacturers present
    vi.mocked(useBlob).mockImplementation((path: string | null) => {
      if (path === "clubs.json") return { data: [], loading: false, notFound: false, error: null };
      if (path === "manufacturers.json") return { data: mockManufacturers, loading: false, notFound: false, error: null };
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
});
