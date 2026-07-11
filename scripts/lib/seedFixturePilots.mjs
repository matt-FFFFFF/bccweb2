// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  PILOT_COUNT,
  TS_CS_VERSION,
} from "./loadTestConsts.mjs";

export function buildFixturePilots({ manifest, now, pilotPasswordHash }) {
  const userIndexEntries = {};
  const pilotEmailIndexEntries = {};
  const coordinatorPilotIds = new Set(
    manifest.coordinators.map(({ pilotId }) => pilotId)
  );
  const pilots = Array.from({ length: PILOT_COUNT }, (_, i) => {
    const n = i + 1;
    const topologyPilot = manifest.pilots[i];
    const { id: pilotId, userId, email, clubId, clubName, clubTeamId, seasonYear } = topologyPilot;
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
        seasonClubs: [{ seasonYear, clubId, clubName, clubTeamId }],
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
        roles: coordinatorPilotIds.has(pilotId)
          ? ["Pilot", "RoundsCoord"]
          : ["Pilot"],
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
