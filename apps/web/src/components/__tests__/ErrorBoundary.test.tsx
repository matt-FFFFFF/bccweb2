// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ErrorBoundary } from "../ErrorBoundary.js";

function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("Boom!");
  return <div>child rendered ok</div>;
}

describe("ErrorBoundary", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("renders children when there is no error", () => {
    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Boom shouldThrow={false} />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByText("child rendered ok")).toBeInTheDocument();
  });

  it("catches render error and shows fallback with message", () => {
    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Boom shouldThrow={true} />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: /something went wrong/i })).toBeInTheDocument();
    expect(screen.getByText(/Boom!/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go home/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });

  it("does NOT auto-reset when re-rendered with the same key", () => {
    const { rerender } = render(
      <MemoryRouter>
        <ErrorBoundary key="same">
          <Boom shouldThrow={true} />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: /something went wrong/i })).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <ErrorBoundary key="same">
          <Boom shouldThrow={false} />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.queryByText("child rendered ok")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /something went wrong/i })).toBeInTheDocument();
  });

  it("auto-resets when key changes (simulating route change)", () => {
    const { rerender } = render(
      <MemoryRouter>
        <ErrorBoundary key="/page-a">
          <Boom shouldThrow={true} />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: /something went wrong/i })).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <ErrorBoundary key="/page-b">
          <Boom shouldThrow={false} />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByText("child rendered ok")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /something went wrong/i })).not.toBeInTheDocument();
  });

  it("reload button calls window.location.reload", () => {
    const reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      writable: true,
      value: { ...window.location, reload: reloadSpy },
    });

    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Boom shouldThrow={true} />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});
