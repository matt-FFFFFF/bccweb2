// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Round, RoundBrief } from "@bccweb/types";
import { BriefSchema, RoundSchema } from "@bccweb/schemas";

import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import { getPrivateBlobClient } from "../blob.js";
import { readJson, writePrivateJson } from "../blobJson.js";
import type { PureTrackRoundResult } from "../puretrack.js";

export const RESULT: PureTrackRoundResult = {
  roundGroupId: 100,
  roundGroupName: "BCC Test Site Sat 05 Jul 26",
  roundGroupSlug: "round-100",
  teams: [
    { teamId: "team-1", groupId: 101, groupSlug: "north-falcons" },
    { teamId: "team-2", groupId: 102, groupSlug: "south-falcons" },
  ],
};

export function roundFixture(): Round {
  const id = randomUUID();
  return {
    id,
    date: "2026-07-05",
    status: "Locked",
    isLocked: true,
    maxTeams: 2,
    minimumScore: 5,
    site: { id: "site-1", name: "Test Site" },
    season: { year: 2026 },
    pureTrack: { status: "processing", attemptId: "attempt-A", updatedAt: "before" },
    scoring: {
      taskMaxPoints: 1000,
      clubsAttendingCount: 2,
      clubsAttendingFactor: 0.5,
      minDistanceFlightCount: 1,
      minDistanceFactor: 0.2,
      maxPointsForRound: 100,
      maxPilotScoreInRound: 42,
      maxTeamScore: 84,
      maxPilotScoresCountedPerTeam: 4,
      leagueRoundScoresCounted: 6,
      pilotFactors: { "Club Pilot": 1, Pilot: 1, "Advanced Pilot": 0.9 },
      wingFactors: {
        "EN A": 1,
        "EN B": 1,
        "EN C": 0.9,
        "EN C 2-liner": 0.85,
        "EN D": 0.8,
        "EN D 2-liner": 0.75,
      },
      teams: [
        { teamId: "team-1", workingTeamScore: 84 },
        { teamId: "team-2", workingTeamScore: 63 },
      ],
      scoredAt: "2026-07-05T12:00:00.000Z",
    },
    teams: [
      teamFixture("team-1", "club-1", "North Club", true),
      teamFixture("team-2", "club-2", "South Club", false),
    ],
  };
}

export function briefFixture(round: Round): RoundBrief {
  return {
    roundId: round.id,
    generatedAt: "2026-07-05T10:00:00.000Z",
    date: round.date,
    siteName: round.site.name,
    hash: "frozen-material-hash",
    version: 4,
    versionHistory: [{
      version: 4,
      hash: "frozen-material-hash",
      createdAt: "2026-07-05T10:00:00.000Z",
      createdBy: "coord-1",
    }],
    briefingTime: "09:30",
    teams: round.teams.map((team) => ({
      teamName: team.teamName,
      clubName: team.club.name,
      pilots: [],
    })),
  };
}

export async function seed(round: Round, brief: RoundBrief): Promise<void> {
  await seedRound(round);
  await writePrivateJson(`round-briefs/${round.id}.json`, BriefSchema, brief);
}

export async function seedRound(round: Round): Promise<void> {
  await writePrivateJson(`rounds/${round.id}.json`, RoundSchema, round);
}

export async function readRound(id: string): Promise<Round> {
  const path = `rounds/${id}.json`;
  return readJson(getPrivateBlobClient(path), RoundSchema, path);
}

export async function readBrief(id: string): Promise<RoundBrief> {
  const path = `round-briefs/${id}.json`;
  return readJson(getPrivateBlobClient(path), BriefSchema, path);
}

export async function bytes(path: string): Promise<Buffer> {
  return getPrivateContainer().getBlockBlobClient(path).downloadToBuffer();
}

function teamFixture(
  id: string,
  clubId: string,
  clubName: string,
  signToFly: boolean,
): Round["teams"][number] {
  return {
    id,
    teamName: "Falcons",
    club: { id: clubId, name: clubName },
    score: id === "team-1" ? 100 : 75,
    pilots: [{
      placeInTeam: 1,
      isScoring: true,
      status: "Filled",
      accountedFor: true,
      signToFly,
      noScore: false,
      pilotPoints: 50,
      pilotId: `pilot-${id}`,
      snapshot: null,
      flight: null,
    }],
  };
}
