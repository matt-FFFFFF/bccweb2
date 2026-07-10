// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { lazy, Suspense } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { LoadingSpinner } from "../LoadingSpinner.js";

/**
 * Regression lock for the failure mode introduced by route code-splitting
 * (Todo 2): a deployed client can request a chunk that has been removed or
 * gone stale, so the `React.lazy()` dynamic `import()` REJECTS at runtime
 * ("Failed to fetch dynamically imported module").
 *
 * This reproduces, in isolation, the `<ErrorBoundary>` → `<Suspense>` nesting
 * that router.tsx now uses and asserts graceful degradation: the boundary
 * catches the rejected import and renders its "Something went wrong" fallback
 * instead of leaving a blank/white screen.
 *
 * `MemoryRouter` is required because the fallback renders a `<Link to="/">`,
 * which throws without a Router context.
 *
 * The per-test `console.error` spy mirrors ErrorBoundary.test.tsx exactly:
 * React logs the caught error (and the rejected-lazy notice) via
 * `console.error`, which the global setup.ts React-19 gate would otherwise
 * turn into a failure. The spy wraps that gate with a noop for this test only
 * — the sanctioned, precedented escape, NOT a widening of the global allowlist.
 */
const Exploding = lazy(() =>
  Promise.reject(new Error("Failed to fetch dynamically imported module")),
);

describe("ErrorBoundary + lazy chunk-load failure", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("catches a rejected lazy import() and shows the fallback (no white screen)", async () => {
    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Suspense fallback={<LoadingSpinner />}>
            <Exploding />
          </Suspense>
        </ErrorBoundary>
      </MemoryRouter>,
    );

    // The lazy rejection settles on a microtask, so the fallback appears async.
    expect(
      await screen.findByRole("heading", { name: /something went wrong/i }),
    ).toBeInTheDocument();
    // The rejected chunk-load error message surfaces in the fallback's <pre>.
    expect(
      screen.getByText(/Failed to fetch dynamically imported module/),
    ).toBeInTheDocument();
  });
});
