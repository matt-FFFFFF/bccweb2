// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect } from "vitest";
import { buildPilotClubHistory } from "../../../../scripts/migrate/pilot-club-history-logic.mjs";

describe("buildPilotClubHistory", () => {
  it("legacy PilotClub rows migrate to club-history entries with correct count", () => {
    const pilotUuid = new Map<number, string>([
      [1, "pilot-uuid-1"],
      [2, "pilot-uuid-2"],
    ]);
    const clubUuid = new Map<number, string>([
      [10, "club-uuid-10"],
      [20, "club-uuid-20"],
    ]);
    const clubsList = [
      { id: "club-uuid-10", name: "Alpha Club" },
      { id: "club-uuid-20", name: "Beta Club" },
    ];

    const rows = [
      { ID: 1, Pilot_ID: 1, Club_ID: 10, JoinedAt: new Date("2010-01-01"), LeftAt: new Date("2015-12-31") },
      { ID: 2, Pilot_ID: 1, Club_ID: 20, JoinedAt: new Date("2016-01-01"), LeftAt: null },
      { ID: 3, Pilot_ID: 2, Club_ID: 10, JoinedAt: null, LeftAt: null },
    ];

    const result = buildPilotClubHistory(rows, pilotUuid, clubUuid, clubsList, []);

    expect(result.size).toBe(2);
    expect(result.get("pilot-uuid-1")).toHaveLength(2);
    expect(result.get("pilot-uuid-2")).toHaveLength(1);
    expect(result.get("pilot-uuid-1")![0].source).toBe("legacy");
    expect(result.get("pilot-uuid-1")![0].clubName).toBe("Alpha Club");
    expect(result.get("pilot-uuid-1")![0].legacyId).toBe(1);
  });

  it("pilot with no legacy PilotClub rows but currentSeasonClub -> single 'current' entry created", () => {
    const pilotUuid = new Map<number, string>([[1, "pilot-uuid-1"]]);
    const clubUuid = new Map<number, string>();
    const clubsList: { id: string; name: string }[] = [];

    const pilotsWithCurrentClub = [
      {
        pilotId: "pilot-uuid-1",
        currentSeasonClub: { clubId: "club-x", clubName: "X Club" },
      },
    ];

    const result = buildPilotClubHistory([], pilotUuid, clubUuid, clubsList, pilotsWithCurrentClub);

    expect(result.size).toBe(1);
    const entries = result.get("pilot-uuid-1")!;
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("current");
    expect(entries[0].clubId).toBe("club-x");
    expect(entries[0].clubName).toBe("X Club");
  });

  it("null joinedAt/leftAt preserved as null (NOT fabricated to a date)", () => {
    const pilotUuid = new Map<number, string>([[1, "pilot-uuid-1"]]);
    const clubUuid = new Map<number, string>([[10, "club-uuid-10"]]);
    const clubsList = [{ id: "club-uuid-10", name: "Test Club" }];

    const rows = [{ ID: 5, Pilot_ID: 1, Club_ID: 10, JoinedAt: null, LeftAt: null }];

    const result = buildPilotClubHistory(rows, pilotUuid, clubUuid, clubsList, []);

    const entries = result.get("pilot-uuid-1")!;
    expect(entries).toBeDefined();
    expect(entries[0].joinedAt).toBeNull();
    expect(entries[0].leftAt).toBeNull();
  });
});
