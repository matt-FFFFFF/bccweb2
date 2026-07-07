// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Flight } from "@bccweb/types";
import { ManualFlightModal } from "../ManualFlightModal.js";
import { api } from "../../../../lib/api.js";

vi.mock("../../../../lib/api.js", async () => {
  const actual = await vi.importActual("../../../../lib/api.js");
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  };
});

function savedFlight(): Flight {
  return {
    id: "f-new",
    distance: 55.5,
    scoringType: "Manual",
    score: 0,
    wingFactor: 0,
    isManualLog: true,
    manualLogJustification: "Logger died mid-flight; estimated from PureTrack track",
  };
}

const baseProps = {
  roundId: "r1",
  teamId: "t1",
  place: 2,
  pilotName: "Manny Log",
  isOpen: true,
};

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ManualFlightModal", () => {
  it("posts to the slot manual-flight URL with the correct body and fires onSaved/onClose", async () => {
    const flight = savedFlight();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    vi.mocked(api.post).mockResolvedValue(flight);

    render(<ManualFlightModal {...baseProps} onClose={onClose} onSaved={onSaved} />);

    fireEvent.change(screen.getByTestId("manual-distance-input"), {
      target: { value: "55.5" },
    });
    fireEvent.change(screen.getByTestId("manual-justification-input"), {
      target: { value: "Logger died mid-flight; estimated from PureTrack track" },
    });

    fireEvent.click(screen.getByTestId("manual-save-btn"));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        "rounds/r1/teams/t1/pilots/2/manual-flight",
        {
          distance: 55.5,
          manualLogJustification: "Logger died mid-flight; estimated from PureTrack track",
        },
      );
    });
    expect(onSaved).toHaveBeenCalledWith(flight);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("includes the optional url/duration/dateTime fields when supplied", async () => {
    vi.mocked(api.post).mockResolvedValue(savedFlight());

    render(<ManualFlightModal {...baseProps} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByTestId("manual-distance-input"), {
      target: { value: "42" },
    });
    fireEvent.change(screen.getByTestId("manual-justification-input"), {
      target: { value: "PureTrack estimate after logger failure" },
    });
    fireEvent.change(screen.getByTestId("manual-duration-input"), {
      target: { value: "95" },
    });
    fireEvent.change(screen.getByTestId("manual-url-input"), {
      target: { value: "https://puretrack.io/x" },
    });
    fireEvent.change(screen.getByTestId("manual-datetime-input"), {
      target: { value: "2026-06-09T14:30" },
    });

    fireEvent.click(screen.getByTestId("manual-save-btn"));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        "rounds/r1/teams/t1/pilots/2/manual-flight",
        {
          distance: 42,
          manualLogJustification: "PureTrack estimate after logger failure",
          url: "https://puretrack.io/x",
          duration: 95,
          dateTime: "2026-06-09T14:30",
        },
      );
    });
  });

  it("rejects submission (no api.post) when the justification is empty", () => {
    const onSaved = vi.fn();
    render(<ManualFlightModal {...baseProps} onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByTestId("manual-distance-input"), {
      target: { value: "42" },
    });
    // justification left empty
    fireEvent.click(screen.getByTestId("manual-save-btn"));

    expect(api.post).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId("justification-error")).toBeInTheDocument();
  });

  it("rejects submission when the justification is too short (< 10 chars)", () => {
    render(<ManualFlightModal {...baseProps} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByTestId("manual-distance-input"), {
      target: { value: "42" },
    });
    fireEvent.change(screen.getByTestId("manual-justification-input"), {
      target: { value: "too short" },
    });
    fireEvent.click(screen.getByTestId("manual-save-btn"));

    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByTestId("justification-error")).toBeInTheDocument();
  });

  it("rejects submission when distance is <= 0", () => {
    render(<ManualFlightModal {...baseProps} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByTestId("manual-distance-input"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByTestId("manual-justification-input"), {
      target: { value: "A perfectly valid justification sentence" },
    });
    fireEvent.click(screen.getByTestId("manual-save-btn"));

    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByTestId("distance-error")).toBeInTheDocument();
  });

  it("rejects submission when distance exceeds 10000 km", () => {
    render(<ManualFlightModal {...baseProps} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByTestId("manual-distance-input"), {
      target: { value: "10001" },
    });
    fireEvent.change(screen.getByTestId("manual-justification-input"), {
      target: { value: "A perfectly valid justification sentence" },
    });
    fireEvent.click(screen.getByTestId("manual-save-btn"));

    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByTestId("distance-error")).toBeInTheDocument();
  });

  it("renders nothing when isOpen is false", () => {
    render(
      <ManualFlightModal
        {...baseProps}
        isOpen={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("manual-flight-modal")).toBeNull();
  });
});
