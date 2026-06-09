import { describe, expect, it } from "vitest";
import type { RoundBrief } from "@bccweb/types";
import { computeBriefHash, diffMaterialFields } from "../briefVersion.js";

describe("brief version hashing", () => {
  it("computeBriefHash deterministic: same input → same hash 100 times", () => {
    const brief = makeBrief();
    const hashes = Array.from({ length: 100 }, () => computeBriefHash(brief));

    expect(new Set(hashes).size).toBe(1);
  });

  it("computeBriefHash changes when material field changes (e.g. NOTAMs added)", () => {
    const before = makeBrief({ NOTAMs: "None" });
    const after = makeBrief({ NOTAMs: "Temporary restricted area active" });

    expect(computeBriefHash(after)).not.toBe(computeBriefHash(before));
  });

  it("computeBriefHash does NOT change when cosmetic field changes (e.g. briefer name or phone)", () => {
    const before = makeBrief({ brieferName: "Alice", brieferPhone: "07000 000000" });
    const after = makeBrief({ brieferName: "Bob", brieferPhone: "07111 111111" });

    expect(computeBriefHash(after)).toBe(computeBriefHash(before));
  });

  it("diffMaterialFields returns only material diffs", () => {
    const before = makeBrief({
      NOTAMs: "None",
      brieferName: "Alice",
      site: { parkingW3W: "alpha.bravo.charlie" },
    });
    const after = makeBrief({
      NOTAMs: "Temporary restricted area active",
      brieferName: "Bob",
      site: { parkingW3W: "delta.echo.foxtrot" },
    });

    expect(diffMaterialFields(before, after)).toEqual([
      "NOTAMs",
      "site.parkingW3W",
    ]);
  });
});

function makeBrief(overrides: Record<string, unknown> = {}): RoundBrief {
  return {
    roundId: "round-1",
    generatedAt: "2026-06-09T10:00:00.000Z",
    date: "2026-06-09",
    siteName: "Cosmetic Site Name",
    briefingTime: "10:00",
    checkInByTime: "17:00",
    landByTime: "16:30",
    organisingClubName: "Cosmetic Club",
    pureTrackGroupName: "Cosmetic PureTrack",
    teams: [],
    narrative: "Fly the declared route",
    windSpeedDirection: "10kt WSW",
    directionOfFlight: "East",
    expectedLandingArea: "Goal field",
    airspaceAndHazards: "Avoid controlled airspace",
    NOTAMs: "None",
    BENO_LineDescription: "BENO line description",
    briefersNotes: "Watch sea breeze",
    site: {
      parkingW3W: "alpha.bravo.charlie",
      briefingW3W: "bravo.charlie.delta",
      takeOffW3W: "charlie.delta.echo",
    },
    ...overrides,
  } as RoundBrief;
}
