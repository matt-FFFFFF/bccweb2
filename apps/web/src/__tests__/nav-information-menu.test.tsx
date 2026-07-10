// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Information nav dropdown", () => {
  it("renders for anonymous, Pilot, RoundsCoord, and Admin users", () => {
    const rolesToTest: (UserRole[] | null)[] = [null, ["Pilot"], ["RoundsCoord"], ["Admin"]];

    for (const roles of rolesToTest) {
      const identity = roles ? identityWithRoles(roles, "test@bcc.test") : null;
      const { unmount } = renderNav(identity);

      const trigger = screen.getByRole("button", { name: "Information" });
      expect(trigger).toBeInTheDocument();
      unmount();
    }
  });

  it("is closed by default", () => {
    renderNav(null);
    const infoTrigger = screen.getByRole("button", { name: "Information" });
    const infoDropdown = infoTrigger.closest(".bcc-nav__dropdown") as HTMLElement;

    expect(infoTrigger).toHaveAttribute("aria-expanded", "false");
    expect(within(infoDropdown).queryByRole("link")).toBeNull();
  });

  it("opens on click and shows 5 specific links in order", () => {
    renderNav(null);
    const infoTrigger = screen.getByRole("button", { name: "Information" });
    const infoDropdown = infoTrigger.closest(".bcc-nav__dropdown") as HTMLElement;

    fireEvent.click(infoTrigger);

    expect(infoTrigger).toHaveAttribute("aria-expanded", "true");

    const links = within(infoDropdown).getAllByRole("link");
    expect(links).toHaveLength(5);

    const expectedTexts = [
      "About the BCC",
      "BCC Rules",
      "Briefing Aide Memoire",
      "COVID Risk Assessment",
      "Paragliding SOPs"
    ];

    expect(links.map(l => l.textContent?.trim())).toEqual(expectedTexts);

    // Check specific attributes
    expect(links[0]).toHaveAttribute("href", "/about");

    // Check PDF links
    const pdfExpected = [
      { text: "BCC Rules", href: "/static/BCCRulesUpdateApril2025.pdf" },
      { text: "Briefing Aide Memoire", href: "/static/AdvanceBCCBriefingAideMemoireApr2025.pdf" },
      { text: "COVID Risk Assessment", href: "/static/bcccovidra_04_2022.pdf" },
      { text: "Paragliding SOPs", href: "/static/ParaglidingSOPsv1.7.pdf" }
    ];

    for (let i = 0; i < pdfExpected.length; i++) {
      const link = links[i + 1];
      expect(link).toHaveAttribute("href", pdfExpected[i].href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
  });

  it("closes on Escape", () => {
    renderNav(null);
    const infoTrigger = screen.getByRole("button", { name: "Information" });
    const infoDropdown = infoTrigger.closest(".bcc-nav__dropdown") as HTMLElement;

    fireEvent.click(infoTrigger);
    expect(within(infoDropdown).queryAllByRole("link").length).toBeGreaterThan(0);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(within(infoDropdown).queryByRole("link")).toBeNull();
    expect(infoTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on outside click", () => {
    renderNav(null);
    const infoTrigger = screen.getByRole("button", { name: "Information" });
    const infoDropdown = infoTrigger.closest(".bcc-nav__dropdown") as HTMLElement;

    fireEvent.click(infoTrigger);
    expect(within(infoDropdown).queryAllByRole("link").length).toBeGreaterThan(0);

    fireEvent.mouseDown(document.body);

    expect(within(infoDropdown).queryByRole("link")).toBeNull();
  });

  it("closes on route change (clicking a link inside it)", () => {
    renderNav(null);
    const infoTrigger = screen.getByRole("button", { name: "Information" });
    const infoDropdown = infoTrigger.closest(".bcc-nav__dropdown") as HTMLElement;

    fireEvent.click(infoTrigger);

    const aboutLink = within(infoDropdown).getByRole("link", { name: "About the BCC" });
    fireEvent.click(aboutLink);

    expect(within(infoDropdown).queryByRole("link")).toBeNull();
    expect(infoTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when a PDF link (new tab, no route change) is selected", () => {
    renderNav(null);
    const infoTrigger = screen.getByRole("button", { name: "Information" });
    const infoDropdown = infoTrigger.closest(".bcc-nav__dropdown") as HTMLElement;

    fireEvent.click(infoTrigger);
    expect(within(infoDropdown).queryAllByRole("link").length).toBeGreaterThan(0);

    const pdfLink = within(infoDropdown).getByRole("link", { name: "BCC Rules" });
    fireEvent.click(pdfLink);

    expect(within(infoDropdown).queryByRole("link")).toBeNull();
    expect(infoTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it("coexists independently with Admin dropdown", () => {
    // Render as Admin so both dropdowns are present
    renderNav(identityWithRoles(["Admin"], "admin@bcc.test"));

    const infoTrigger = screen.getByRole("button", { name: "Information" });

    // Open ONLY Information
    fireEvent.click(infoTrigger);
    expect(document.querySelectorAll(".bcc-nav__menu").length).toBe(1);

    // Open Admin too (using click, not mouseDown, so it doesn't trigger outside click)
    const adminTrigger = screen.getByRole("button", { name: "Admin" });
    fireEvent.click(adminTrigger);

    // Both should be open
    expect(document.querySelectorAll(".bcc-nav__menu").length).toBe(2);
  });
});