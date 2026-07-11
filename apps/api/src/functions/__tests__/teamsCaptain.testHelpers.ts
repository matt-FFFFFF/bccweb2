// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { BlobLeaseClient } from "@azure/storage-blob";
import type { Round, Team } from "@bccweb/types";
import { vi } from "vitest";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makePilot,
  makeRound,
} from "../../__tests__/helpers/seed.js";

export async function seedRoundWithTeam(
  overrides: {
    readonly clubId?: string;
    readonly captainPilotId?: string | null;
  } = {}
) {
  const clubId = overrides.clubId ?? randomUUID();
  const pilot = await makePilot({ clubId });
  const team: Team = {
    id: randomUUID(),
    teamName: "Alpha",
    club: { id: clubId, name: "Test Club" },
    score: 0,
    captainPilotId: overrides.captainPilotId ?? null,
    pilots: [
      {
        placeInTeam: 1,
        pilotId: pilot.id,
        isScoring: true,
        status: "Filled",
        accountedFor: false,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        snapshot: null,
        flight: null,
      },
    ],
  };
  const round = await makeRound({
    organisingClubId: clubId,
    organisingClubName: "Test Club",
    teams: [team],
  });
  return { round, team, pilot, clubId };
}

export function randomForwardedFor(): string {
  return `10.42.${Math.floor(Math.random() * 250) + 1}.${Math.floor(
    Math.random() * 250
  ) + 1}`;
}

export function makeSetCaptainRequest(
  user: { readonly id: string; readonly email: string },
  round: Round,
  team: Team,
  pilotId: string | null
) {
  return makeAuthRequest(user.id, user.email, {
    method: "PUT",
    params: { id: round.id, teamId: team.id },
    headers: { "x-forwarded-for": randomForwardedFor() },
    body: { pilotId },
  });
}

export function failCaptainRoundLeaseOnce(
  roundPath: string,
  statusCode: number
) {
  const originalAcquireLease = BlobLeaseClient.prototype.acquireLease;
  const acquireLease = vi.spyOn(BlobLeaseClient.prototype, "acquireLease");
  let pendingFailure = true;
  let roundAttempts = 0;
  acquireLease.mockImplementation(function (this: BlobLeaseClient, duration, options) {
    if (pendingFailure && this.url.includes(roundPath)) {
      roundAttempts += 1;
      pendingFailure = false;
      return Promise.reject(leaseError(statusCode));
    }
    if (this.url.includes(roundPath)) roundAttempts += 1;
    return originalAcquireLease.call(this, duration, options);
  });
  return { roundAttempts: () => roundAttempts };
}

function leaseError(
  statusCode: number
): Error & { readonly statusCode: number } {
  return Object.assign(new Error(`lease conflict (${statusCode})`), { statusCode });
}
