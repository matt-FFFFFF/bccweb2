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
  useBlob: (p: string | null) => mockUseBlob(p),
}));

vi.mock("../../lib/api.js", async () => ({
  ...(await vi.importActual("../../lib/api.js")),
  api: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

describe("FirstLoginOfSeasonGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockUseBlob.mockImplementation((p: string | null) =>
      p?.startsWith("results/")
        ? { data: [] }
        : { data: [{ id: "c1", name: "Club 1" }] }
    );
  });

  it("does not render modal if firstLoginOfSeason is false", async () => {
    mockUseAuth.mockReturnValue({
      identity: { roles: ["Pilot"], pilotId: "p1", firstLoginOfSeason: false, activeSeasonYear: 2026 },
      loading: false,
    });
    
    render(
      <BrowserRouter useTransitions={true}>
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
      <BrowserRouter useTransitions={true}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Welcome back to the 2026 season/)).toBeInTheDocument();
    });
  });

  it("forces season-T&C interception under useTransitions={true}: aria-modal dialog + action controls render (not deferred/skipped)", async () => {
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
      <BrowserRouter useTransitions={true}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    // Regression guard: transition-wrapped rendering must NOT defer/skip the forced gate.
    // Keep these dialog + action-control assertions — they prove interception still fires.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent(/Welcome back to the 2026 season/);
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Confirm & Save" })).toBeEnabled();
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
      <BrowserRouter useTransitions={true}>
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
      <BrowserRouter useTransitions={true}>
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

  it("disables club select and shows note if pilot has flown", async () => {
    mockUseAuth.mockReturnValue({
      identity: { roles: ["Pilot"], pilotId: "p1", firstLoginOfSeason: true, activeSeasonYear: 2026 },
      loading: false,
    });
    mockUseBlob.mockImplementation((p: string | null) =>
      p?.startsWith("results/")
        ? { data: [{ teamResults: [{ pilots: [{ pilotId: "p1", pilotName: "N", distance: 1, score: 1, wingClass: "EN-B" }] }] }] }
        : { data: [{ id: "c1", name: "Club 1" }] }
    );
    vi.mocked(api.get).mockResolvedValueOnce({
      person: { phoneNumber: "123" },
      emergencyContactName: "Mom",
      emergencyPhoneNumber: "911",
      wingClass: "EN-A",
      currentClub: { id: "c1" }
    });

    render(
      <BrowserRouter useTransitions={true}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Welcome back to the 2026 season/)).toBeInTheDocument();
    });

    const select = screen.getByLabelText("Current Club") as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect(screen.getByText("(locked — you've flown; contact an admin)")).toBeInTheDocument();
  });

  it("does not disable club select for an admin who has flown (admin override)", async () => {
    mockUseAuth.mockReturnValue({
      identity: { roles: ["Admin"], pilotId: "p1", firstLoginOfSeason: true, activeSeasonYear: 2026 },
      loading: false,
    });
    mockUseBlob.mockImplementation((p: string | null) =>
      p?.startsWith("results/")
        ? { data: [{ teamResults: [{ pilots: [{ pilotId: "p1", pilotName: "N", distance: 1, score: 1, wingClass: "EN-B" }] }] }] }
        : { data: [{ id: "c1", name: "Club 1" }] }
    );
    vi.mocked(api.get).mockResolvedValueOnce({
      person: { phoneNumber: "123" },
      emergencyContactName: "Mom",
      emergencyPhoneNumber: "911",
      wingClass: "EN-A",
      currentClub: { id: "c1" }
    });

    render(
      <BrowserRouter useTransitions={true}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Welcome back to the 2026 season/)).toBeInTheDocument();
    });

    const select = screen.getByLabelText("Current Club") as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    expect(screen.queryByText("(locked — you've flown; contact an admin)")).toBeNull();
  });

  it("does not disable club select if pilot has not flown", async () => {
    mockUseAuth.mockReturnValue({
      identity: { roles: ["Pilot"], pilotId: "p1", firstLoginOfSeason: true, activeSeasonYear: 2026 },
      loading: false,
    });
    // Default mockUseBlob returns { data: [] } for results, so flown is false.
    vi.mocked(api.get).mockResolvedValueOnce({
      person: { phoneNumber: "123" },
      emergencyContactName: "Mom",
      emergencyPhoneNumber: "911",
      wingClass: "EN-A",
      currentClub: { id: "c1" }
    });

    render(
      <BrowserRouter useTransitions={true}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Welcome back to the 2026 season/)).toBeInTheDocument();
    });

    const select = screen.getByLabelText("Current Club") as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    expect(screen.queryByText("(locked — you've flown; contact an admin)")).toBeNull();
  });

  it("does not disable club select for null-pilotId row", async () => {
    mockUseAuth.mockReturnValue({
      identity: { roles: ["Pilot"], pilotId: "p1", firstLoginOfSeason: true, activeSeasonYear: 2026 },
      loading: false,
    });
    mockUseBlob.mockImplementation((p: string | null) =>
      p?.startsWith("results/")
        ? { data: [{ teamResults: [{ pilots: [{ pilotId: null, pilotName: "Foreign Pilot", distance: 1, score: 1, wingClass: "EN-B" }] }] }] }
        : { data: [{ id: "c1", name: "Club 1" }] }
    );
    vi.mocked(api.get).mockResolvedValueOnce({
      person: { phoneNumber: "123" },
      emergencyContactName: "Mom",
      emergencyPhoneNumber: "911",
      wingClass: "EN-A",
      currentClub: { id: "c1" }
    });

    render(
      <BrowserRouter useTransitions={true}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Welcome back to the 2026 season/)).toBeInTheDocument();
    });

    const select = screen.getByLabelText("Current Club") as HTMLSelectElement;
    expect(select).not.toBeDisabled();
  });

  it("shows clear CLUB_LOCKED message when api.put rejects with 409 CLUB_LOCKED ApiError", async () => {
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
    // Need to import ApiError from the actual module to use it here.
    // The vi.mock is using importActual.
    const { ApiError } = await import("../../lib/api.js");
    vi.mocked(api.put).mockRejectedValueOnce(new ApiError(409, "CLUB_LOCKED", "Pilot is locked to club X."));

    render(
      <BrowserRouter useTransitions={true}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Welcome back to the 2026 season/)).toBeInTheDocument();
    });

    const submitBtns = await screen.findAllByText("Confirm & Save"); const submitBtn = submitBtns[0];
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText("You cannot change your club because you have already flown for another club this season. Please contact an admin.")).toBeInTheDocument();
    });
  });

  it("dismissed within 24h -> modal NOT shown on re-render", async () => {
    localStorage.setItem("bcc_first_login_dismissed_until", String(Date.now() + 10000));
    mockUseAuth.mockReturnValue({
      identity: { roles: ["Pilot"], pilotId: "p1", firstLoginOfSeason: true, activeSeasonYear: 2026 },
      loading: false,
    });
    
    render(
      <BrowserRouter useTransitions={true}>
        <FirstLoginOfSeasonGate>
          <div data-testid="child">Child Content</div>
        </FirstLoginOfSeasonGate>
      </BrowserRouter>
    );

    await waitFor(() => expect(screen.queryByText(/Welcome back to the 2026 season/)).toBeNull());
  });
});
