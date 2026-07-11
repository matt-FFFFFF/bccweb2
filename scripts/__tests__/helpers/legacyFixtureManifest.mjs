// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { deterministicUuid } from "../../lib/blobSeed.mjs";
import { SEASON_YEAR } from "../../lib/loadTestConsts.mjs";

export function buildLegacyFixtureManifest({ roundIds = [] } = {}) {
  const clubIds = Array.from({ length: 50 }, (_, index) =>
    deterministicUuid("fixture-club", `club${index + 1}`)
  );
  const emails = Array.from({ length: 500 }, (_, index) =>
    `pilot${String(index + 1).padStart(3, "0")}@bcc.local`
  );
  return {
    seasonYear: SEASON_YEAR,
    siteIds: ["Site Alpha", "Site Bravo", "Site Charlie"]
      .map((name) => deterministicUuid("fixture-site", name)),
    clubIds,
    teamIds: clubIds.flatMap((clubId) => [1, 2].map((teamNumber) =>
      deterministicUuid("fixture-club-team", `${clubId}-${teamNumber}`)
    )),
    pilotIds: emails.map((email) => deterministicUuid("fixture-pilot", email)),
    userIds: emails.map((email) => deterministicUuid("fixture-user", email)),
    roundIds,
  };
}
