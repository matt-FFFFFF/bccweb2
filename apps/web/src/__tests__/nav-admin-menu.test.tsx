// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { CallerIdentity, UserRole } from "@bccweb/types";
import type { AuthState } from "../hooks/useAuth.js";

// Only `useAuth` is overridden; loginUrl / AuthError / AuthContext stay real.
const mockUseAuth = vi.fn<() => AuthState>();

vi.mock("../hooks/useAuth.js", async (importActual) => {
  const actual = await importActual<typeof import("../hooks/useAuth.js")>();
  return { ...actual, useAuth: () => mockUseAuth() };
});

// Imported AFTER the mock is declared (vi.mock is hoisted, so order is safe).
import { Nav } from "../router.js";

function identityWithRoles(roles: UserRole[], email: string): CallerIdentity {
  return { userId: "u-1", email, roles, pilotId: null, clubId: null };
}

function authState(identity: CallerIdentity | null): AuthState {
  return {
    identity,
    loading: false,
    isRefreshing: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshIdentity: vi.fn(),
  };
}

function renderNav(identity: CallerIdentity | null) {
  mockUseAuth.mockReturnValue(authState(identity));
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Nav />
    </MemoryRouter>,
  );
}

function queryMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".bcc-nav__menu");
}

function getMenu(): HTMLElement {
  const menu = queryMenu();
  if (menu === null) throw new Error("expected the admin menu (.bcc-nav__menu) to be open");
  return menu;
}

function menuLinkTexts(): string[] {
  return Array.from(getMenu().querySelectorAll("a")).map((a) => a.textContent?.trim() ?? "");
}

const EXPECTED_ADMIN_LINKS = ["Clubs", "Config", "Manufacturers", "Seasons", "Sign-to-fly wording", "Sites", "Users"];

const admin = () => identityWithRoles(["Admin"], "admin@bcc.test");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Admin nav dropdown", () => {
  it("admin: renders an 'Admin' trigger and no menu / no standalone Sites until opened", () => {
    renderNav(admin());

    const trigger = screen.getByRole("button", { name: "Admin" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    expect(queryMenu()).toBeNull();
    expect(screen.queryByRole("link", { name: "Sites" })).toBeNull();
  });

  it("admin: opening the trigger reveals all seven links in lexicographic order, Sites only inside the menu", () => {
    renderNav(admin());

    fireEvent.click(screen.getByRole("button", { name: "Admin" }));

    expect(screen.getByRole("button", { name: "Admin" })).toHaveAttribute("aria-expanded", "true");
    expect(menuLinkTexts()).toEqual(EXPECTED_ADMIN_LINKS);

    // Exactly one Sites link in the whole nav, and it lives inside the menu.
    expect(menuLinkTexts()).toContain("Sites");
    expect(screen.getAllByRole("link", { name: "Sites" })).toHaveLength(1);
  });

  it("admin: the Manufacturers link is present in the menu and points to /admin/manufacturers", () => {
    renderNav(admin());

    fireEvent.click(screen.getByRole("button", { name: "Admin" }));

    const manufacturers = screen.getByRole("link", { name: "Manufacturers" });
    expect(manufacturers).toHaveAttribute("href", "/admin/manufacturers");
    expect(menuLinkTexts()).toContain("Manufacturers");
  });

  it("admin: Escape closes the menu", () => {
    renderNav(admin());
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(queryMenu()).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(queryMenu()).toBeNull();
    expect(screen.getByRole("button", { name: "Admin" })).toHaveAttribute("aria-expanded", "false");
  });

  it("admin: an outside pointer-down closes the menu", () => {
    renderNav(admin());
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(queryMenu()).not.toBeNull();

    fireEvent.mouseDown(document.body);

    expect(queryMenu()).toBeNull();
  });

  it("admin: selecting a menu item (route change) closes the menu", () => {
    renderNav(admin());
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));

    fireEvent.click(screen.getByRole("link", { name: "Users" }));

    expect(queryMenu()).toBeNull();
    expect(screen.getByRole("button", { name: "Admin" })).toHaveAttribute("aria-expanded", "false");
  });

  it("coord (non-admin): no Admin trigger, but a standalone Sites link", () => {
    renderNav(identityWithRoles(["RoundsCoord"], "coord@bcc.test"));

    expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    // The Information dropdown is shown to all users, so a coord now sees exactly one nav
    // dropdown (Information) and never the Admin dropdown.
    expect(screen.getByRole("button", { name: "Information" })).toBeInTheDocument();
    expect(document.querySelectorAll(".bcc-nav__dropdown")).toHaveLength(1);

    const sites = screen.getByRole("link", { name: "Sites" });
    expect(sites).toHaveAttribute("href", "/admin/sites");
  });

  it("pilot: neither an Admin trigger nor a Sites link", () => {
    renderNav(identityWithRoles(["Pilot"], "pilot@bcc.test"));

    expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sites" })).toBeNull();
  });

  it("anonymous: neither an Admin trigger nor a Sites link", () => {
    renderNav(null);

    expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sites" })).toBeNull();
  });
});
