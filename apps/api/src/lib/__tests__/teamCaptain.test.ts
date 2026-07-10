// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import type { Team, PilotSlot } from "@bccweb/types";
import { recomputeTeamCaptain } from "../teamCaptain.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: "team-1",
    teamName: "Alpha",
    club: { id: "club-1", name: "Test Club" },
    score: 0,
    pilots: [],
    captainPilotId: null,
    ...overrides,
  };
}

function filledSlot(placeInTeam: number, pilotId: string): PilotSlot {
  return {
    placeInTeam,
    pilotId,
    isScoring: true,
    status: "Filled",
    accountedFor: false,
    signToFly: false,
    noScore: false,
    pilotPoints: 0,
    snapshot: null,
    flight: null,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("recomputeTeamCaptain", () => {
  it("adding pilot to place 1 of team with null captain → captain = pilotId", () => {
    const team = makeTeam({
      pilots: [filledSlot(1, "pilot-a")],
      captainPilotId: null,
    });

    const result = recomputeTeamCaptain(team);

    expect(result.captainPilotId).toBe("pilot-a");
  });

  it("adding pilot to place 1 of team with existing captain → captain UNCHANGED", () => {
    const team = makeTeam({
      pilots: [filledSlot(1, "pilot-a")],
      captainPilotId: "pilot-b",
    });

    const result = recomputeTeamCaptain(team);

    expect(result.captainPilotId).toBe("pilot-b");
  });

  it("removing place-1 pilot → captain reassigns to lowest-numbered remaining place's pilot", () => {
    // Simulate: place 1 was already removed; pilots array now has places 2 and 3
    const team = makeTeam({
      pilots: [filledSlot(2, "pilot-b"), filledSlot(3, "pilot-c")],
      captainPilotId: "pilot-a", // was place-1 pilot before removal
    });

    const result = recomputeTeamCaptain(team);

    expect(result.captainPilotId).toBe("pilot-b");
  });

  it("removing only filled pilot → captain becomes null", () => {
    const team = makeTeam({
      pilots: [],
      captainPilotId: "pilot-a",
    });

    const result = recomputeTeamCaptain(team);

    expect(result.captainPilotId).toBeNull();
  });

  it("place 1 filled, captain already non-null → captain unchanged regardless of place-1 pilot", () => {
    const team = makeTeam({
      pilots: [filledSlot(1, "pilot-a"), filledSlot(2, "pilot-b")],
      captainPilotId: "pilot-b", // operator manually picked place-2 pilot
    });

    const result = recomputeTeamCaptain(team);

    expect(result.captainPilotId).toBe("pilot-b");
  });

  it("empty team with null captain → captain remains null", () => {
    const team = makeTeam({ pilots: [], captainPilotId: null });

    const result = recomputeTeamCaptain(team);

    expect(result.captainPilotId).toBeNull();
  });

  it("non-place-1 slot removal while place 1 still filled → captain unchanged", () => {
    const team = makeTeam({
      pilots: [filledSlot(1, "pilot-a")], // place 2 already removed
      captainPilotId: "pilot-a",
    });

    const result = recomputeTeamCaptain(team);

    expect(result.captainPilotId).toBe("pilot-a");
  });

  it("returns new object — does not mutate the input team", () => {
    const team = makeTeam({
      pilots: [filledSlot(1, "pilot-a")],
      captainPilotId: null,
    });
    const originalCaptain = team.captainPilotId;

    const result = recomputeTeamCaptain(team);

    expect(team.captainPilotId).toBe(originalCaptain); // input unchanged
    expect(result).not.toBe(team);                     // new object returned
    expect(result.captainPilotId).toBe("pilot-a");
  });
});
