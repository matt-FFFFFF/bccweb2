import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { AdminUserView } from "@bccweb/types";
import AdminUsers from "../Users.js";

// react-router: keep everything real except useNavigate (spied so we can assert
// the create-pilot redirect without a real navigation).
const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

// Admin caller identity.
vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: () => ({
    identity: { roles: ["Admin"], userId: "admin-1", email: "admin@b.c", pilotId: null, clubId: null },
    loading: false,
    isRefreshing: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshIdentity: vi.fn(),
  }),
}));

// Clubs come from a public blob via useBlob — feed the "Admin club" dropdown.
vi.mock("../../../hooks/useBlob.js", () => ({
  useBlob: () => ({
    data: [{ id: "club-1", name: "Alpha" }],
    loading: false,
    error: null,
    notFound: false,
  }),
}));

// Authenticated API client. Preserve ApiError (the component does
// `ex instanceof ApiError` for the EMAIL_TAKEN branch).
vi.mock("../../../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api.js")>();
  return {
    ApiError: actual.ApiError,
    api: {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
      deleteJson: vi.fn(),
    },
  };
});

import { api, ApiError } from "../../../lib/api.js";

function makeUser(overrides: Partial<AdminUserView> = {}): AdminUserView {
  return {
    id: "u1",
    email: "alice@example.com",
    roles: ["Pilot"],
    pilotId: null,
    clubId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    emailVerified: true,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminUsers />
    </MemoryRouter>,
  );
}

describe("AdminUsers (Users & Pilots)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders users fetched from GET manage/users", async () => {
    vi.mocked(api.get).mockResolvedValue([
      makeUser({ id: "u1", email: "alice@example.com", emailVerified: true }),
      makeUser({ id: "u2", email: "bob@example.com", emailVerified: false }),
    ]);

    renderPage();

    expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("manage/users");
  });

  it("toggles a row open and closed", async () => {
    vi.mocked(api.get).mockResolvedValue([makeUser({ id: "u1", email: "alice@example.com" })]);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Save email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("button", { name: "Save email" })).toBeNull();
  });

  it("shows the 'Admin club' label (renamed from 'Club')", async () => {
    vi.mocked(api.get).mockResolvedValue([makeUser({ id: "u1" })]);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByText("Admin club")).toBeInTheDocument();
    // The old bare "Club" label must be gone.
    expect(screen.queryByText("Club")).toBeNull();
  });

  it("saves a new email and then reveals the Verify button (verification reset)", async () => {
    const verified = makeUser({ id: "u1", email: "alice@example.com", emailVerified: true });
    vi.mocked(api.get).mockResolvedValue([verified]);
    vi.mocked(api.put).mockResolvedValue({ ...verified, email: "new@example.com", emailVerified: false });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    // Starts verified → no Verify button.
    expect(screen.queryByRole("button", { name: "Verify email" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save email" }));

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("manage/users/u1/email", { email: "new@example.com" });
    });

    // emailVerified flipped false locally → Verify button THEN appears.
    expect(await screen.findByRole("button", { name: "Verify email" })).toBeInTheDocument();
  });

  it("surfaces 'Email already in use.' when save-email returns 409 EMAIL_TAKEN", async () => {
    vi.mocked(api.get).mockResolvedValue([makeUser({ id: "u1", email: "alice@example.com" })]);
    vi.mocked(api.put).mockRejectedValueOnce(new ApiError(409, "EMAIL_TAKEN", "conflict"));

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "taken@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save email" }));

    expect(await screen.findByText("Email already in use.")).toBeInTheDocument();
  });

  it("shows Verify only when unverified and force-verifies via verify-email", async () => {
    vi.mocked(api.get).mockResolvedValue([makeUser({ id: "u2", email: "bob@example.com", emailVerified: false })]);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Verify email" }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("manage/users/u2/verify-email");
    });
    // onRefresh re-runs the fetch (flush the refresh cycle inside act).
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it("hides the Verify button for already-verified users", async () => {
    vi.mocked(api.get).mockResolvedValue([makeUser({ id: "u1", emailVerified: true })]);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("button", { name: "Verify email" })).toBeNull();
  });

  it("saves roles with roles+clubId only (pilotId omitted)", async () => {
    vi.mocked(api.get).mockResolvedValue([makeUser({ id: "u1", roles: ["Pilot"], clubId: null })]);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("manage/users/u1/roles", { roles: ["Pilot"], clubId: null });
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it("renders Pilot ID read-only (no input) with a link to the pilot profile", async () => {
    vi.mocked(api.get).mockResolvedValue([makeUser({ id: "u1", pilotId: "pilot-xyz" })]);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    // Shown as plain text…
    expect(screen.getByText("pilot-xyz")).toBeInTheDocument();
    // …never inside an editable form control.
    expect(screen.queryByDisplayValue("pilot-xyz")).toBeNull();
    expect(screen.getByRole("link", { name: "Edit pilot profile" })).toBeInTheDocument();
  });

  it("creates a pilot profile then navigates to it", async () => {
    vi.mocked(api.get).mockResolvedValue([makeUser({ id: "u2", email: "bob@example.com", pilotId: null })]);
    vi.mocked(api.post).mockResolvedValue({ pilot: { id: "new-pilot-9" } });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Create pilot profile" }));

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Jane" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Doe" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/pilots/new-pilot-9");
    });
    expect(api.post).toHaveBeenCalledWith("manage/users/u2/pilot", { firstName: "Jane", lastName: "Doe" });
  });

  it("deletes the account via api.delete after confirm", async () => {
    vi.mocked(api.get).mockResolvedValue([makeUser({ id: "u1", email: "alice@example.com" })]);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith("manage/users/u1");
    });
  });

  it("does NOT delete when confirm is cancelled", async () => {
    vi.mocked(api.get).mockResolvedValue([makeUser({ id: "u1", email: "alice@example.com" })]);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(api.delete).not.toHaveBeenCalled();
  });
});
