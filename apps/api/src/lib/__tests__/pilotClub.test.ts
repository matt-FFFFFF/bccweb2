import { describe, expect, test } from "vitest";
import type { Pilot } from "@bccweb/types";
import { pilotClubIdForSeason } from "../pilotClub.js";

function makePilot(overrides: Pick<Pilot, "seasonClubs" | "currentClub">): Pilot {
  return {
    id: "pilot-1",
    legacyId: null,
    coachType: "None",
    pilotRating: "Club Pilot",
    person: {
      id: "person-1",
      firstName: "Test",
      lastName: "Pilot",
      fullName: "Test Pilot",
    },
    seasonClubs: overrides.seasonClubs,
    userId: null,
    ...(overrides.currentClub && { currentClub: overrides.currentClub }),
  };
}

describe("pilotClubIdForSeason", () => {
  test("returns season club when the pilot has a club for the requested season", () => {
    const pilot = makePilot({
      seasonClubs: [{ seasonYear: 2026, clubId: "A", clubName: "A" }],
    });

    const clubId = pilotClubIdForSeason(pilot, 2026);

    expect(clubId).toBe("A");
  });

  test("falls back to current club when the pilot has no season clubs", () => {
    const pilot = makePilot({
      seasonClubs: [],
      currentClub: { id: "C", name: "C" },
    });

    const clubId = pilotClubIdForSeason(pilot, 2026);

    expect(clubId).toBe("C");
  });

  test("prefers season club over current club for the requested season", () => {
    const pilot = makePilot({
      seasonClubs: [{ seasonYear: 2026, clubId: "A", clubName: "A" }],
      currentClub: { id: "C", name: "C" },
    });

    const clubId = pilotClubIdForSeason(pilot, 2026);

    expect(clubId).toBe("A");
  });

  test("returns null when the pilot has neither a season club nor a current club", () => {
    const pilot = makePilot({ seasonClubs: [] });

    const clubId = pilotClubIdForSeason(pilot, 2026);

    expect(clubId).toBeNull();
  });
});
