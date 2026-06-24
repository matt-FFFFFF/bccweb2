import "./setup.ts";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import Home from "../pages/Home.js";

vi.mock("../hooks/useBlob.js", () => ({
  useBlob: (path: string) => {
    if (path === "rounds.json") {
      return { data: [], loading: false, error: null, notFound: false };
    }

    if (path === "seasons.json") {
      return {
        data: [{ year: 2026, active: true }],
        loading: false,
        error: null,
        notFound: false,
      };
    }

    if (path === "seasons/2026.json") {
      return {
        data: { leagueTable: [] },
        loading: false,
        error: null,
        notFound: false,
      };
    }

    return { data: null, loading: false, error: null, notFound: true };
  },
}));

describe("Home", () => {
  it("renders the landing intro", () => {
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    );

    expect(
      screen.getByText("Advance British Club Challenge (BCC)", { exact: false }),
    ).toBeVisible();
  });
});
