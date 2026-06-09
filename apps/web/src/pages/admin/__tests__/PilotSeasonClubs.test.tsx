import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { BrowserRouter } from "react-router-dom";
import PilotSeasonClubs from "../PilotSeasonClubs.js";
import { api, ApiError } from "../../../lib/api.js";
import * as useAuthMod from "../../../hooks/useAuth.js";
import * as useBlobMod from "../../../hooks/useBlob.js";

vi.mock("../../../lib/api.js");
vi.mock("../../../hooks/useAuth.js");
vi.mock("../../../hooks/useBlob.js");

const mockApi = vi.mocked(api);
const mockUseAuth = vi.mocked(useAuthMod.useAuth);
const mockUseBlob = vi.mocked(useBlobMod.useBlob);

describe("PilotSeasonClubs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({
      identity: { roles: ["Admin"], userId: "admin1", email: "admin@test" },
      loading: false,
      login: vi.fn(),
      logout: vi.fn(),
      clearAuth: vi.fn(),
    });

    mockUseBlob.mockImplementation((path: string) => {
      if (path === "pilots.json") {
        return { data: [{ id: "p1", name: "Pilot One" }], loading: false, error: null, notFound: false };
      }
      if (path === "clubs.json") {
        return { data: [{ id: "c1", name: "Club One" }], loading: false, error: null, notFound: false };
      }
      return { data: null, loading: false, error: null, notFound: false };
    });

    mockApi.get.mockImplementation(async (path: string) => {
      if (path.includes("pilot-season-clubs")) {
        return [{ pilotId: "p1", clubId: "c1", seasonYear: 2026 }];
      }
      if (path.includes("clubs")) {
        return [{ clubId: "c1", seasonYear: 2026 }];
      }
      return [];
    });
  });

  it("renders table with year filter", async () => {
    render(<BrowserRouter><PilotSeasonClubs /></BrowserRouter>);
    
    await waitFor(() => {
      expect(screen.getByText("Pilot One")).toBeInTheDocument();
      expect(screen.getByText("Club One")).toBeInTheDocument();
    });
  });

  it("Assign modal submits with correct payload", async () => {
    mockApi.post.mockResolvedValueOnce({});
    mockUseBlob.mockImplementation((path: string) => {
      if (path === "pilots.json") {
        return { data: [{ id: "p2", name: "Pilot Two" }], loading: false, error: null, notFound: false };
      }
      return { data: [], loading: false, error: null, notFound: false };
    });
    
    render(<BrowserRouter><PilotSeasonClubs /></BrowserRouter>);
    await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());
    
    fireEvent.click(screen.getByText("Assign Pilot"));
    
    const pilotSelect = screen.getByRole("combobox", { name: /pilot/i });
    const clubSelect = screen.getByRole("combobox", { name: /club/i });
    
    fireEvent.change(pilotSelect, { target: { value: "p2" } });
    fireEvent.change(clubSelect, { target: { value: "c1" } });
    
    fireEvent.click(screen.getByText("Submit"));
    
    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        expect.stringContaining("admin/pilot-season-clubs"),
        { pilotId: "p2", clubId: "c1", seasonYear: expect.any(Number) }
      );
    });
  });

  it("PILOT_ALREADY_ASSIGNED surfaces Replace option", async () => {
    mockApi.post.mockRejectedValueOnce({ code: "PILOT_ALREADY_ASSIGNED" });
    mockUseBlob.mockImplementation((path: string) => {
      if (path === "pilots.json") {
        return { data: [{ id: "p2", name: "Pilot Two" }], loading: false, error: null, notFound: false };
      }
      return { data: [], loading: false, error: null, notFound: false };
    });
    
    render(<BrowserRouter><PilotSeasonClubs /></BrowserRouter>);
    await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());
    
    fireEvent.click(screen.getByText("Assign Pilot"));
    
    fireEvent.change(screen.getByRole("combobox", { name: /pilot/i }), { target: { value: "p2" } });
    fireEvent.change(screen.getByRole("combobox", { name: /club/i }), { target: { value: "c1" } });
    
    fireEvent.click(screen.getByText("Submit"));
    
    await waitFor(() => {
      expect(screen.getByText(/Replace existing assignment/i)).toBeInTheDocument();
    });
  });
});
