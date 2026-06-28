import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// We render the REAL app router (`<App />` from router.tsx) so that the REAL
// `RequireAuth` guard and the REAL `loginUrl()` helper exercise the redirect.
// `RequireAuth` is module-private, so the only faithful way to test it is via
// the real router. We keep `loginUrl` / `AuthError` real (importActual) and
// only override `useAuth` (to inject an unauthenticated identity) and
// `AuthProvider` (a pass-through that skips the network init effect).

const mockUseAuth = vi.fn();

vi.mock("../hooks/useAuth.js", async (importActual) => {
  const actual = await importActual<typeof import("../hooks/useAuth.js")>();
  return {
    ...actual,
    useAuth: () => mockUseAuth(),
    AuthProvider: ({ children }: { children: ReactNode }) => children,
  };
});

const mockUseBlob = vi.fn();
vi.mock("../hooks/useBlob.js", () => ({
  useBlob: () => mockUseBlob(),
}));

vi.mock("../lib/api.js", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

// Imported AFTER the mocks are declared (vi.mock is hoisted, so order is safe).
import App from "../router.js";

const UNAUTHENTICATED = {
  identity: null,
  loading: false,
  isRefreshing: false,
  login: vi.fn(),
  logout: vi.fn(),
  refreshIdentity: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockUseAuth.mockReturnValue(UNAUTHENTICATED);
  // The season gate reads the public clubs blob; identity:null short-circuits
  // it before the data is used, but return a benign shape regardless.
  mockUseBlob.mockReturnValue({ data: [], loading: false, error: null, notFound: false });
});

afterEach(() => {
  // Reset jsdom history so each test starts from a known location.
  window.history.replaceState({}, "", "/");
});

describe("router guards (AC#1: protected-route redirect)", () => {
  it("redirects an unauthenticated visit to /rounds → /login?return=%2Frounds", async () => {
    // Start the BrowserRouter at the protected path.
    window.history.replaceState({}, "", "/rounds");

    render(<App />);

    // RequireAuth issues <Navigate replace> → BrowserRouter syncs window.location.
    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });

    // pathname-only, URL-encoded return param — matches loginUrl(location.pathname).
    expect(window.location.search).toBe("?return=%2Frounds");

    // The real Login page rendered at the redirect target.
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  // Sibling test (same unauth beforeEach setup): pins React Router's transition
  // semantics now that the app runs <BrowserRouter useTransitions={true}> — the
  // redirect must REPLACE (not push) and settle cleanly with no remount churn.
  it("redirects via <Navigate replace> with a clean transition (no back-entry, no console noise, single /login settle)", async () => {
    // Start at the protected path, then spy on the History API BEFORE render so
    // we can prove the guard REPLACES rather than PUSHES the navigation entry.
    window.history.replaceState({}, "", "/rounds");
    // Spy AFTER seeding the start location so the initial replaceState above is
    // not counted. window.history.length is brittle under jsdom; spying on the
    // History API is a deterministic, mechanism-level check of <Navigate replace>.
    const pushSpy = vi.spyOn(window.history, "pushState");
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    // Capture any console noise emitted for the duration of the render + redirect.
    // Real spies (not silenced) so a failure surfaces the offending message verbatim.
    const errorSpy = vi.spyOn(console, "error");
    const warnSpy = vi.spyOn(console, "warn");
    try {
      render(<App />);

      await waitFor(() => {
        expect(window.location.pathname).toBe("/login");
      });

      // Replace semantics: <Navigate replace> must drive the History API's
      // replaceState — never pushState — so there is no back-button trap to the
      // protected route. A regression to a PUSH navigation would call pushState.
      expect(pushSpy).not.toHaveBeenCalled();
      expect(replaceSpy).toHaveBeenCalled();

      // Clean transition (no remount storm) under useTransitions={true}:
      //  (a) we settled exactly once on /login,
      //  (b) the Login page rendered a SINGLE "Sign in" heading — getByRole throws
      //      if a remount storm duplicated it, and
      //  (c) no console.error / console.warn fired during the transition (no act()
      //      churn, no ErrorBoundary remount noise).
      expect(window.location.pathname).toBe("/login");
      expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      pushSpy.mockRestore();
      replaceSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("router warnings (AC#4: no router deprecation / future-flag warnings)", () => {
  it("emits ZERO router deprecation or future-flag console messages on a representative render", async () => {
    const DEPRECATION = /deprecat|future flag|v7_|will change/i;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      // Representative app render (BrowserRouter + Routes settle on a real page).
      window.history.replaceState({}, "", "/login");
      render(<App />);
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
      });

      const messages = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .map((args) => args.map(String).join(" "));
      const offenders = messages.filter((m) => DEPRECATION.test(m));

      expect(offenders).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
