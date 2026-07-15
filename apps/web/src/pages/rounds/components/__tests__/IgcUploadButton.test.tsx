// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { IgcUploadButton } from "../IgcUploadButton.js";

// Mock fetch globally
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("shows spinner, calls api, and displays success distance", async () => {
  const onUploaded = vi.fn();

  const mockFlight = {
    id: "flight-123",
    distance: 42.5,
    score: 42.5,
    scoringType: "XC" as const,
    wingFactor: 1.0,
    isManualLog: false,
    igcPath: "flights/123.igc",
    sanityFlags: ["GPS_SPIKE"],
  };

  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    json: async () => mockFlight,
  });

  render(
    <IgcUploadButton
      roundId="round-1"
      teamId="team-A"
      place={1}
      currentFlight={null}
      onUploaded={onUploaded}
    />
  );

  const button = screen.getByTestId("upload-igc-btn");
  expect(button.textContent).toBe("Upload IGC");

  const input = screen.getByTestId("upload-igc-input");
  const file = new File(["dummy content"], "test.igc", { type: "text/plain" });

  fireEvent.change(input, { target: { files: [file] } });

  // Spinner should appear immediately
  await waitFor(() => {
    expect(screen.getByTestId("upload-spinner")).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  // After upload
  await waitFor(() => {
    expect(screen.queryByTestId("upload-spinner")).not.toBeInTheDocument();
  });

  expect(globalThis.fetch).toHaveBeenCalledWith(
    "/api/rounds/round-1/teams/team-A/pilots/1/igc",
    expect.objectContaining({
      method: "POST",
    })
  );

  expect(onUploaded).toHaveBeenCalledWith(mockFlight);

  const distanceMsg = screen.getByTestId("flight-distance");
  expect(distanceMsg.textContent).toBe("Scored distance: 42.5 km");
  expect(screen.getByText(/GPS_SPIKE/)).toBeInTheDocument();
  expect(screen.queryByTestId("flight-validation")).not.toBeInTheDocument();
});

test("shows validation result on success", async () => {
  const onUploaded = vi.fn();

  const mockFlight = {
    id: "flight-124",
    distance: 100.0,
    score: 100.0,
    scoringType: "XC" as const,
    wingFactor: 1.0,
    isManualLog: false,
    igcPath: "flights/124.igc",
    sanityFlags: [],
    validation: {
      date: "invalid",
      signature: "pending",
    },
  };

  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    json: async () => mockFlight,
  });

  render(
    <IgcUploadButton
      roundId="round-1"
      teamId="team-A"
      place={1}
      currentFlight={null}
      onUploaded={onUploaded}
    />
  );

  const input = screen.getByTestId("upload-igc-input");
  const file = new File(["dummy content"], "test.igc", { type: "text/plain" });

  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() => {
    expect(screen.queryByTestId("upload-spinner")).not.toBeInTheDocument();
  });

  const validationEl = screen.getByTestId("flight-validation");
  expect(validationEl).toBeInTheDocument();
  expect(screen.getByText("Date: invalid")).toBeInTheDocument();
  expect(screen.getByText("checking… (coordinator will see final result)")).toBeInTheDocument();
});

test("shows error message on 413", async () => {
  const onUploaded = vi.fn();

  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: false,
    status: 413,
  });

  render(
    <IgcUploadButton
      roundId="round-1"
      teamId="team-A"
      place={1}
      currentFlight={null}
      onUploaded={onUploaded}
    />
  );

  const input = screen.getByTestId("upload-igc-input");
  const file = new File(["dummy content"], "test.igc", { type: "text/plain" });

  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() => {
    expect(screen.getByText("File too large (max 15MB)")).toBeInTheDocument();
  });
  
  expect(onUploaded).not.toHaveBeenCalled();
});
