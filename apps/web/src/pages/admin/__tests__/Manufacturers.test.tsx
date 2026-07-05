import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import AdminManufacturers from "../Manufacturers.js";
import { readPublicBlob } from "../../../lib/blobClient.js";
import { api } from "../../../lib/api.js";
import { useAuth } from "../../../hooks/useAuth.js";

// Mock hooks
vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api.js")>();
  return {
    ApiError: actual.ApiError,
    api: {
      post: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("../../../lib/blobClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/blobClient.js")>();
  return {
    ...actual,
    readPublicBlob: vi.fn(),
  };
});

describe("AdminManufacturers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuth).mockReturnValue({
      identity: { roles: ["Admin"], userId: "u1", email: "a@b.c", pilotId: null, clubId: null },
      loading: false,
      isRefreshing: false,
      login: vi.fn(),
      logout: vi.fn(),
      refreshIdentity: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    vi.mocked(readPublicBlob).mockImplementation(async (path: string) => {
      const base = path.split("?")[0];
      if (base === "manufacturers.json") {
        return [
          { id: "m-1", name: "Ozone" },
          { id: "m-2", name: "Advance", websiteUrl: "https://advance.swiss" },
        ];
      }
      throw Object.assign(new Error("Not found"), {
        name: "BlobNotFoundError",
        status: 404,
      });
    });
  });

  it("renders with a mocked 2-item list and shows both rows", async () => {
    render(
      <MemoryRouter>
        <AdminManufacturers />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(readPublicBlob).toHaveBeenCalledWith("manufacturers.json?v=0", undefined);
    });

    expect(screen.getByText("Ozone")).toBeInTheDocument();
    expect(screen.getByText("Advance")).toBeInTheDocument();
    expect(screen.getByText("https://advance.swiss")).toBeInTheDocument();
  });

  it("creates a manufacturer and calls api.post", async () => {
    render(
      <MemoryRouter>
        <AdminManufacturers />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(readPublicBlob).toHaveBeenCalledWith("manufacturers.json?v=0", undefined);
    });

    const nameInput = screen.getByPlaceholderText("Name");
    fireEvent.change(nameInput, { target: { value: "Nova" } });

    const createBtn = screen.getByRole("button", { name: "Create" });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("manufacturers", { name: "Nova", websiteUrl: undefined });
      expect(readPublicBlob).toHaveBeenCalledWith("manufacturers.json?v=1", undefined);
    });
  });

  it("inline edits and saves, calling api.put", async () => {
    render(
      <MemoryRouter>
        <AdminManufacturers />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(readPublicBlob).toHaveBeenCalledWith("manufacturers.json?v=0", undefined);
    });

    const editBtns = screen.getAllByRole("button", { name: "Edit" });
    fireEvent.click(editBtns[0]); // Edit Ozone

    const websiteInput = screen.getAllByPlaceholderText("Website URL")[0];
    fireEvent.change(websiteInput, { target: { value: "https://flyozone.com" } });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("manufacturers/m-1", { name: "Ozone", websiteUrl: "https://flyozone.com" });
      expect(readPublicBlob).toHaveBeenCalledWith("manufacturers.json?v=1", undefined);
    });
  });

  it("deletes after confirming, calling api.delete", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <MemoryRouter>
        <AdminManufacturers />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(readPublicBlob).toHaveBeenCalledWith("manufacturers.json?v=0", undefined);
    });

    const deleteBtns = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteBtns[0]);

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith("manufacturers/m-1");
      expect(readPublicBlob).toHaveBeenCalledWith("manufacturers.json?v=1", undefined);
    });
  });

  it("handles notFound gracefully: renders form, not spinner", async () => {
    vi.mocked(readPublicBlob).mockImplementation(async () => {
      throw Object.assign(new Error("Not found"), {
        name: "BlobNotFoundError",
        status: 404,
      });
    });

    render(
      <MemoryRouter>
        <AdminManufacturers />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("No manufacturers yet.")).toBeInTheDocument();
    });

    expect(screen.queryByText("Loading manufacturers…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("shows Admin access required for non-admins", async () => {
    vi.mocked(useAuth).mockReturnValue({
      identity: { roles: ["Pilot"], userId: "u2", email: "a@b.c", pilotId: null, clubId: null },
      loading: false,
    } as unknown as ReturnType<typeof useAuth>);

    render(
      <MemoryRouter>
        <AdminManufacturers />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Admin access required.")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
  ])("does NOT render a live link for an unsafe websiteUrl: %s", async (websiteUrl) => {
    vi.mocked(readPublicBlob).mockImplementation(async (path: string) => {
      const base = path.split("?")[0];
      if (base === "manufacturers.json") {
        return [{ id: "m-evil", name: "EvilCorp", websiteUrl }];
      }
      throw Object.assign(new Error("Not found"), {
        name: "BlobNotFoundError",
        status: 404,
      });
    });

    render(
      <MemoryRouter>
        <AdminManufacturers />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("EvilCorp")).toBeInTheDocument();
    });

    expect(screen.getByText(websiteUrl)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
