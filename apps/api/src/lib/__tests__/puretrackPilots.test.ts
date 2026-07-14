// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Round } from "@bccweb/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as blobJson from "../blobJson.js";
import { loadPilotPureTrackIds } from "../puretrackPilots.js";

const PILOT_ID = "pilot-1";

function roundWithPilot(): Round {
  return {
    id: "round-1",
    date: "2026-07-14",
    status: "Locked",
    isLocked: true,
    maxTeams: 1,
    minimumScore: 0,
    site: { id: "site-1", name: "Test Site" },
    season: { year: 2026 },
    teams: [{
      id: "team-1",
      teamName: "Test Team",
      club: { id: "club-1", name: "Test Club" },
      score: 0,
      pilots: [{
        placeInTeam: 1,
        isScoring: true,
        status: "Filled",
        accountedFor: false,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        pilotId: PILOT_ID,
        snapshot: null,
        flight: null,
      }],
    }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadPilotPureTrackIds", () => {
  it("skips a Filled pilot when the private pilot blob is missing", async () => {
    // Given
    const round = roundWithPilot();

    // When
    const ids = await loadPilotPureTrackIds(round);

    // Then
    expect(ids).toEqual(new Map());
  });

  it("propagates a non-404 pilot read failure so the queue job can retry", async () => {
    // Given
    const storageError = Object.assign(new Error("storage unavailable"), { statusCode: 503 });
    vi.spyOn(blobJson, "readJson").mockRejectedValueOnce(storageError);

    // When
    const operation = loadPilotPureTrackIds(roundWithPilot());

    // Then
    await expect(operation).rejects.toBe(storageError);
  });
});
