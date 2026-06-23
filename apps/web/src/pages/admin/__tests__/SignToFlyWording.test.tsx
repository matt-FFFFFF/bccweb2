import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminSignToFlyWording from "../SignToFlyWording.js";
import { api, ApiError } from "../../../lib/api.js";

vi.mock("../../../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/api.js")>("../../../lib/api.js");
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
    },
  };
});

vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: () => ({
    identity: {
      userId: "admin-user",
      email: "admin@example.test",
      roles: ["Admin"],
      pilotId: null,
      clubId: null,
    },
    loading: false,
    isRefreshing: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshIdentity: vi.fn(),
  }),
}));

describe("AdminSignToFlyWording", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("treats missing active wording as an empty state and keeps the publish form visible", async () => {
    mockWordingGets({
      active: Promise.reject(new ApiError(503, "WORDING_NOT_SEEDED", "Error")),
      history: Promise.resolve([]),
    });

    render(<AdminSignToFlyWording />);

    expect(await screen.findByRole("heading", { name: "Publish new version" })).toBeVisible();
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Currently active \(version none\)/ })).toBeVisible();
  });

  it("loads version history even when active wording is not seeded", async () => {
    mockWordingGets({
      active: Promise.reject(new ApiError(503, "WORDING_NOT_SEEDED", "Error")),
      history: Promise.resolve([
        {
          version: 1,
          blobPath: "sign-to-fly/wording/1.json",
          lastModified: "2026-01-01T00:00:00.000Z",
        },
      ]),
    });

    render(<AdminSignToFlyWording />);

    const expectedDate = new Date("2026-01-01T00:00:00.000Z").toLocaleDateString();
    expect(await screen.findByText(expectedDate)).toBeInTheDocument();
    expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/i)).not.toBeInTheDocument();
  });

  it("keeps genuine active wording load errors fatal", async () => {
    mockWordingGets({
      active: Promise.reject(new ApiError(500, "INTERNAL", "boom")),
      history: Promise.resolve([]),
    });

    render(<AdminSignToFlyWording />);

    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Publish new version" })).not.toBeInTheDocument();
  });

  it("shows active version and next publish version when active wording exists", async () => {
    mockWordingGets({
      active: Promise.resolve({ version: 2, html: "<p>x</p>", plainText: "x" }),
      history: Promise.resolve([
        {
          version: 2,
          blobPath: "sign-to-fly/wording/2.json",
          lastModified: "2026-01-02T00:00:00.000Z",
        },
        {
          version: 1,
          blobPath: "sign-to-fly/wording/1.json",
          lastModified: "2026-01-01T00:00:00.000Z",
        },
      ]),
    });

    render(<AdminSignToFlyWording />);

    expect(await screen.findByRole("heading", { name: /Currently active \(version 2\)/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish Version 3" })).toBeInTheDocument();
  });
});

function mockWordingGets(responses: {
  active: Promise<unknown>;
  history: Promise<unknown>;
}) {
  vi.mocked(api.get).mockImplementation((path) => {
    if (path === "sign-to-fly/wording/active") return responses.active;
    if (path === "manage/sign-to-fly/wording") return responses.history;
    return Promise.reject(new Error(`unexpected api.get ${path}`));
  });
}
