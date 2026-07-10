// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";

import { readPrivateJson } from "../../__tests__/helpers/seed.js";
import { upsertPilotClubMap } from "../pilotClubMap.js";

// Each test uses a DISTINCT seasonYear. The per-file Azurite container is shared
// across tests in this file (fileParallelism:false), so distinct years keep each
// test's pilot-club-map.json blob from bleeding into another. Years are arbitrary
// and only need to be unique within this file.
const mapPath = (year: number): string =>
  `seasons/${year}/pilot-club-map.json`;

describe("upsertPilotClubMap", () => {
  it("writes a single pilot→club entry into an empty map", async () => {
    // Given: no pilot-club-map exists for this season yet.
    const year = 4101;

    // When: a pilot is upserted.
    await upsertPilotClubMap(year, "pilot-1", "club-1");

    // Then: the map holds exactly that one entry.
    const map = await readPrivateJson<Record<string, string>>(mapPath(year));
    expect(map).toEqual({ "pilot-1": "club-1" });
  });

  it("overwrites the same pilot's club (last-writer-wins, idempotent)", async () => {
    // Given / When: the same pilot is upserted twice with different clubs.
    const year = 4102;
    await upsertPilotClubMap(year, "pilot-1", "club-1");
    await upsertPilotClubMap(year, "pilot-1", "club-2");

    // Then: only the latest club remains for that pilot.
    const map = await readPrivateJson<Record<string, string>>(mapPath(year));
    expect(map).toEqual({ "pilot-1": "club-2" });
  });

  it("preserves an existing pilot when a second pilot is upserted", async () => {
    // Given: pilot-1 is already mapped.
    const year = 4103;
    await upsertPilotClubMap(year, "pilot-1", "club-1");

    // When: a second, different pilot is upserted.
    await upsertPilotClubMap(year, "pilot-2", "club-2");

    // Then: the leased RMW preserved pilot-1 — it was NOT clobbered.
    const map = await readPrivateJson<Record<string, string>>(mapPath(year));
    expect(map).toEqual({ "pilot-1": "club-1", "pilot-2": "club-2" });
  });
});
