// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildLoadTestManifest,
  coordinatorPilotIndices,
} from "../lib/loadTestTopology.mjs";
import { buildFixturePilots } from "../lib/seedFixturePilots.mjs";

const TEST_SEASON_YEAR = 2031;

test("pilot fixtures follow canonical club-team ownership and coordinator roles", () => {
  // Given the canonical manifest and fixed persistence inputs
  const manifest = buildLoadTestManifest({
    seasonYear: TEST_SEASON_YEAR,
    siteNames: ["Site Alpha", "Site Bravo", "Site Charlie"],
  });

  // When pilot storage records are constructed
  const fixtures = buildFixturePilots({
    manifest,
    now: "2031-01-02T03:04:05.000Z",
    pilotPasswordHash: "hash",
  });

  // Then every stored relationship and role follows the manifest topology
  const coordinatorIndices = new Set(coordinatorPilotIndices());
  const coordinators = fixtures.pilots.filter((pilot) => pilot.user.roles.includes("RoundsCoord"));
  const pilotOnly = fixtures.pilots.filter((pilot) => !pilot.user.roles.includes("RoundsCoord"));
  for (const [pilotIndex, fixture] of fixtures.pilots.entries()) {
    const topologyPilot = manifest.pilots[pilotIndex];
    assert.deepEqual(fixture.privatePilot.seasonClubs[0], {
      seasonYear: TEST_SEASON_YEAR,
      clubId: topologyPilot.clubId,
      clubName: topologyPilot.clubName,
      clubTeamId: topologyPilot.clubTeamId,
    });
    assert.equal(fixture.user.clubId, topologyPilot.clubId);
    assert.deepEqual(
      fixture.user.roles,
      coordinatorIndices.has(pilotIndex) ? ["Pilot", "RoundsCoord"] : ["Pilot"]
    );
  }
  assert.equal(coordinators.length, 25);
  assert.equal(pilotOnly.length, 475);
  assert.equal(fixtures.pilots[0].auth.passwordHash, "hash");
  assert.equal(fixtures.userIndexEntries["pilot001@bcc.local"], manifest.userIds[0]);
  assert.equal(fixtures.pilotEmailIndexEntries["pilot001@bcc.local"], manifest.pilotIds[0]);
});

test("fixture config and setup source contain no auto-allocation flag", () => {
  // Given the fixture seed and setup sources
  const sources = [
    readFileSync(new URL("../seed-fixtures.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("../prepare-loadtest.mjs", import.meta.url), "utf8"),
  ];

  // When the obsolete fixture escape hatch is searched, then no stale claim remains
  for (const source of sources) {
    assert.equal(source.includes("autoAllocatePilotsToRoundClub"), false);
  }
});
