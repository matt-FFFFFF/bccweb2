import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import FirstLoginOfSeasonGate from "../FirstLoginOfSeasonGate.js";
import { BrowserRouter } from "react-router";
import { api } from "../../lib/api.js";

const mockUseAuth = vi.fn();
vi.mock("../../hooks/useAuth.js", () => ({
  useAuth: () => mockUseAuth(),
}));

const mockUseBlob = vi.fn();
vi.mock("../../hooks/useBlob.js", () => ({
  useBlob: () => mockUseBlob(),
}));

vi.mock("../../lib/api.js", () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

describe("FirstLoginOfSeasonGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockUseBlob.mockReturnValue({ data: [{ id: "c1", name: "Club 1" }] });
  });

  it("does not render modal if firstLoginOfSeason is false", async () => {
    mockUseAuth.mockReturnValue({
      identity: { roles: ["Pilot"], pilotId: "p1", firstLoginOfSeason: false, activeSeasonYear: 2026 },
      loading: false,
    });
    
    render(
      <BrowserRouter useTransitions={false}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    expect(screen.getByTestId("child")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Welcome back to the 2026 season/)).toBeNull());
  });

  it("renders modal when firstLoginOfSeason === true", async () => {
    mockUseAuth.mockReturnValue({
      identity: { roles: ["Pilot"], pilotId: "p1", firstLoginOfSeason: true, activeSeasonYear: 2026 },
      loading: false,
    });
    vi.mocked(api.get).mockResolvedValueOnce({
      person: { phoneNumber: "123" },
      emergencyContactName: "Mom",
      emergencyPhoneNumber: "911",
      wingClass: "EN-A",
      currentClub: { id: "c1" }
    });
    
    render(
      <BrowserRouter useTransitions={false}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Welcome back to the 2026 season/)).toBeInTheDocument();
    });
  });

  it("Skip for now sets dismissed_until + closes modal", async () => {
    mockUseAuth.mockReturnValue({
      identity: { roles: ["Pilot"], pilotId: "p1", firstLoginOfSeason: true, activeSeasonYear: 2026 },
      loading: false,
    });
    vi.mocked(api.get).mockResolvedValueOnce({
      person: { phoneNumber: "123" },
      emergencyContactName: "Mom",
      emergencyPhoneNumber: "911",
      wingClass: "EN-A",
      currentClub: { id: "c1" }
    });
    
    render(
      <BrowserRouter useTransitions={false}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    const skipBtns = await screen.findAllByText("Skip for now"); const skipBtn = skipBtns[0];
    fireEvent.click(skipBtn);

    expect(localStorage.getItem("bcc_first_login_dismissed_until")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Welcome back to the 2026 season/)).toBeNull());
  });

  it("Submit calls api.put with form fields + closes modal", async () => {
    mockUseAuth.mockReturnValue({
      identity: { roles: ["Pilot"], pilotId: "p1", firstLoginOfSeason: true, activeSeasonYear: 2026 },
      loading: false,
    });
    vi.mocked(api.get).mockResolvedValueOnce({
      person: { phoneNumber: "123" },
      emergencyContactName: "Mom",
      emergencyPhoneNumber: "911",
      wingClass: "EN-A",
      currentClub: { id: "c1" }
    });
    vi.mocked(api.put).mockResolvedValueOnce({});
    
    render(
      <BrowserRouter useTransitions={false}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    const submitBtns = await screen.findAllByText("Confirm & Save"); const submitBtn = submitBtns[0];
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("pilots/p1", expect.objectContaining({
        emergencyContactName: "Mom",
        emergencyPhoneNumber: "911",
        wingClass: "EN-A",
        currentClub: { id: "c1", name: "Club 1" }
      }));
    });
    
    expect(localStorage.getItem("bcc_first_login_acknowledged_at")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Welcome back to the 2026 season/)).toBeNull());
  });

  it("dismissed within 24h -> modal NOT shown on re-render", async () => {
    localStorage.setItem("bcc_first_login_dismissed_until", String(Date.now() + 10000));
    mockUseAuth.mockReturnValue({
      identity: { roles: ["Pilot"], pilotId: "p1", firstLoginOfSeason: true, activeSeasonYear: 2026 },
      loading: false,
    });
    
    render(
      <BrowserRouter useTransitions={false}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    await waitFor(() => expect(screen.queryByText(/Welcome back to the 2026 season/)).toBeNull());
  });
});
