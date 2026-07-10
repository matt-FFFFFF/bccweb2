// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { PilotSchema } from "@bccweb/schemas";
import type { Pilot } from "@bccweb/types";
import { describe, expect, test } from "vitest";
import "../../__tests__/helpers/azurite.js";
import { getPrivateBlobClient } from "../blob.js";
import { readJson, writePrivateJson } from "../blobJson.js";
import { ensureSeasonClubRecorded, pilotClubIdForSeason, withSeasonClub } from "../pilotClub.js";

function makePilot(
  overrides: Pick<Pilot, "seasonClubs" | "currentClub">,
  id = "pilot-1",
): Pilot {
  return {
    id,
    legacyId: null,
    coachType: "None",
    pilotRating: "Club Pilot",
    person: {
      id: `person-${id}`,
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

describe("withSeasonClub", () => {
  test("replaces the entry for the same season year", () => {
    const seasonClubs = [{ seasonYear: 2025, clubId: "a", clubName: "A" }];

    const result = withSeasonClub(seasonClubs, {
      seasonYear: 2025,
      clubId: "b",
      clubName: "B",
    });

    expect(result).toEqual([{ seasonYear: 2025, clubId: "b", clubName: "B" }]);
    expect(result).toHaveLength(1);
  });

  test("inserts the entry when the season year is absent", () => {
    const seasonClubs = [{ seasonYear: 2024, clubId: "a", clubName: "A" }];

    const result = withSeasonClub(seasonClubs, {
      seasonYear: 2025,
      clubId: "b",
      clubName: "B",
    });

    expect(result).toEqual([
      { seasonYear: 2024, clubId: "a", clubName: "A" },
      { seasonYear: 2025, clubId: "b", clubName: "B" },
    ]);
  });

  test("keeps other season years intact when replacing one entry", () => {
    const seasonClubs = [
      { seasonYear: 2023, clubId: "x", clubName: "X" },
      { seasonYear: 2024, clubId: "a", clubName: "A" },
      { seasonYear: 2026, clubId: "z", clubName: "Z" },
    ];

    const result = withSeasonClub(seasonClubs, {
      seasonYear: 2024,
      clubId: "b",
      clubName: "B",
    });

    expect(result).toEqual([
      { seasonYear: 2023, clubId: "x", clubName: "X" },
      { seasonYear: 2026, clubId: "z", clubName: "Z" },
      { seasonYear: 2024, clubId: "b", clubName: "B" },
    ]);
  });

  test("does not mutate the input array", () => {
    const first = { seasonYear: 2024, clubId: "a", clubName: "A" };
    const seasonClubs = [first];

    withSeasonClub(seasonClubs, { seasonYear: 2025, clubId: "b", clubName: "B" });

    expect(seasonClubs).toHaveLength(1);
    expect(seasonClubs[0]).toBe(first);
  });
});

describe("ensureSeasonClubRecorded", () => {
  test("records a season club and returns it when the pilot has no entry for that season", async () => {
    // Given: a private pilot blob without season-club membership.
    const pilotId = randomUUID();
    const path = `pilots/${pilotId}.json`;
    const pilot = makePilot({ seasonClubs: [] }, pilotId);
    await writePrivateJson(path, PilotSchema, pilot);

    // When: the helper records the pilot's club for the season.
    const clubId = await ensureSeasonClubRecorded(pilotId, 2026, "clubX", "Club X");

    // Then: it returns and persists the newly recorded club.
    const stored = await readJson(getPrivateBlobClient(path), PilotSchema, path);
    expect(clubId).toBe("clubX");
    expect(stored.seasonClubs).toEqual([
      { seasonYear: 2026, clubId: "clubX", clubName: "Club X" },
    ]);
  });

  test("keeps the existing season club and returns its authoritative club id", async () => {
    // Given: a private pilot blob with an existing season-club membership.
    const pilotId = randomUUID();
    const path = `pilots/${pilotId}.json`;
    const seasonClubs = [{ seasonYear: 2026, clubId: "OLD", clubName: "Old" }];
    const pilot = makePilot({ seasonClubs }, pilotId);
    await writePrivateJson(path, PilotSchema, pilot);

    // When: the helper is called with a different club for the same season.
    const clubId = await ensureSeasonClubRecorded(pilotId, 2026, "clubX", "Club X");

    // Then: the existing entry wins and the blob remains unchanged.
    const stored = await readJson(getPrivateBlobClient(path), PilotSchema, path);
    expect(clubId).toBe("OLD");
    expect(stored.seasonClubs).toEqual(seasonClubs);
  });
});
