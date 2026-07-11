// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  CLUB_COUNT,
  FIXTURE_CLUB_NAME,
  FIXTURE_PILOT_EMAIL_PATTERN,
  PILOT_COUNT,
  SEASON_YEAR,
  TS_CS_VERSION,
} from "./loadTestConsts.mjs";

export function buildFixturePilots({ manifest, now, pilotPasswordHash }) {
  const userIndexEntries = {};
  const pilotEmailIndexEntries = {};
  const pilots = Array.from({ length: PILOT_COUNT }, (_, i) => {
    const n = i + 1;
    const email = FIXTURE_PILOT_EMAIL_PATTERN(n).toLowerCase();
    const pilotId = manifest.pilotIds[i];
    const userId = manifest.userIds[i];
    const clubIndex = (n - 1) % CLUB_COUNT;
    const clubId = manifest.clubIds[clubIndex];
    const clubName = FIXTURE_CLUB_NAME(clubIndex + 1);
    const lastName = `P${String(n).padStart(3, "0")}`;
    const fullName = `Pilot ${lastName}`;

    userIndexEntries[email] = userId;
    pilotEmailIndexEntries[email] = pilotId;

    return {
      privatePilot: {
        id: pilotId,
        coachType: "None",
        pilotRating: "Pilot",
        person: {
          id: pilotId,
          firstName: "Pilot",
          lastName,
          fullName,
        },
        currentClub: { id: clubId, name: clubName },
        seasonClubs: [{ seasonYear: SEASON_YEAR, clubId, clubName, clubTeamId: null }],
        userId,
        profileUpdatedAt: now,
      },
      auth: {
        passwordHash: pilotPasswordHash,
        emailVerified: true,
        createdAt: now,
      },
      user: {
        id: userId,
        email,
        roles: ["Pilot"],
        pilotId,
        clubId,
        createdAt: now,
        acceptedTsCsVersion: TS_CS_VERSION,
      },
      summary: {
        id: pilotId,
        name: fullName,
        clubId,
        rating: "Pilot",
      },
    };
  });

  return { pilots, userIndexEntries, pilotEmailIndexEntries };
}
